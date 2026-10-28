// Offline tests for the shared gate: unpaired deny vs ask, a safe allow, the
// 690s hook budget, patch and delete mapping, and Claude hook detection.
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, DEFAULT_APPROVAL_TIMEOUT_MS } from "@oked/sdk";
import {
  HOOK_TIMEOUT_SECONDS,
  decide,
  findClaudeOkedHooks,
  mapFileDelete,
  mapPatch,
} from "../dist/index.js";

let passed = 0;

{
  assert.equal(HOOK_TIMEOUT_SECONDS, DEFAULT_APPROVAL_TIMEOUT_MS / 1000 + 60);
  assert.equal(HOOK_TIMEOUT_SECONDS, 690);
  assert.ok(HOOK_TIMEOUT_SECONDS * 1000 > DEFAULT_APPROVAL_TIMEOUT_MS);
  passed++;
}

{
  const home = mkdtempSync(join(tmpdir(), "oked-core-"));
  const prevHome = process.env.HOME;
  const prevKey = process.env.OKED_API_KEY;
  process.env.HOME = home;
  process.env.OKED_API_KEY = "";
  try {
    const denied = await decide(
      { toolName: "Bash", toolInput: { command: "rm -rf /var/data" } },
      {
        clientId: "@oked/hook-core@test",
        source: "test",
        unpaired: "deny",
        unpairedReason: "OKed: this device is not paired. Pair first: run oked init",
        unpairedLog: "not paired",
        log() {},
      },
    );
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /Pair first: run oked init/);

    const asked = await decide(
      { toolName: "Bash", toolInput: { command: "rm -rf /var/data" } },
      {
        clientId: "@oked/hook-core@test",
        source: "test",
        unpaired: "ask",
        unpairedReason: "OKed: this device is not paired. Run `oked init`.",
        unpairedLog: "not paired",
        log() {},
      },
    );
    assert.equal(asked.decision, "ask");

    const safe = await decide(
      { toolName: "Read", toolInput: { file_path: "README.md" } },
      {
        clientId: "@oked/hook-core@test",
        source: "test",
        unpairedReason: "should not be used",
        unpairedLog: "should not be used",
        log() {},
      },
    );
    assert.equal(safe.decision, "allow");
    assert.equal(safe.reason, undefined);
    passed++;
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.OKED_API_KEY;
    else process.env.OKED_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  }
}

{
  const deleted = mapFileDelete({ path: "/tmp/scratch.txt" });
  assert.equal(deleted.toolName, "Bash");
  assert.equal(classify(deleted.toolName, deleted.toolInput), "warning");

  const real = mapFileDelete({ path: "src/app.ts" });
  assert.equal(classify(real.toolName, real.toolInput), "high_stakes");

  const missing = mapFileDelete({});
  assert.equal(classify(missing.toolName, missing.toolInput), "review");
  passed++;
}

{
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "*** Delete File: /etc/passwd",
    "*** End Patch",
  ].join("\n");
  const mapped = mapPatch(patch);
  assert.equal(mapped.toolName, "Bash");
  assert.equal(classify(mapped.toolName, mapped.toolInput), "high_stakes");

  const write = mapPatch("*** Update File: src/app.ts\n");
  assert.equal(write.toolName, "Write");
  assert.equal(classify(write.toolName, write.toolInput), "warning");

  const secret = mapPatch("*** Add File: /etc/hosts\n");
  assert.equal(classify(secret.toolName, secret.toolInput), "review");

  const unknown = mapPatch("not a patch");
  assert.equal(unknown.toolName, "Edit");
  assert.equal(classify(unknown.toolName, unknown.toolInput), "review");
  passed++;
}

{
  const dir = mkdtempSync(join(tmpdir(), "oked-claude-hooks-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "user-claude");
  try {
    const project = join(dir, "proj");
    const settings = join(project, ".claude", "settings.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "oked-hook" }] }] },
      }),
    );
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "/usr/local/bin/oked-hook" }] }] } }),
    );
    const both = findClaudeOkedHooks(project);
    assert.deepEqual(both.map((hit) => hit.scope).sort(), ["project", "user"]);
    const projectOnly = findClaudeOkedHooks(project, { includeUser: false });
    assert.deepEqual(projectOnly.map((hit) => hit.scope), ["project"]);
    passed++;
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const home = mkdtempSync(join(tmpdir(), "oked-core-net-"));
  let reply = { status: 200, headers: {}, body: "{}" };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/v1/rules" && reply.status < 500) {
        res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
        return;
      }
      if (req.url === "/api/v1/heartbeat" && reply.status < 500) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers }).end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const prev = {
    HOME: process.env.HOME,
    OKED_API_KEY: process.env.OKED_API_KEY,
    OKED_BACKEND_URL: process.env.OKED_BACKEND_URL,
    OKED_REQUIRE_RECEIPT: process.env.OKED_REQUIRE_RECEIPT,
  };
  process.env.HOME = home;
  process.env.OKED_API_KEY = "test-key";
  process.env.OKED_BACKEND_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OKED_REQUIRE_RECEIPT = "0";
  const opts = {
    clientId: "@oked/hook-core@test",
    source: "test",
    unpaired: "deny",
    unpairedReason: "OKed: this device is not paired. Pair first: run oked init",
    unpairedLog: "not paired",
    log() {},
  };
  try {
    reply = { status: 404, headers: { "x-railway-fallback": "true" }, body: JSON.stringify({ message: "Application not found" }) };
    const high = await decide({ toolName: "Bash", toolInput: { command: "rm -rf /var/data" } }, opts);
    assert.equal(high.decision, "deny");
    assert.match(high.reason, /backend unreachable/);
    assert.match(high.reason, /high-stakes denied \(fail-safe\)/);

    const review = await decide({ toolName: "mcp__github__create_issue", toolInput: { title: "x" } }, opts);
    assert.equal(review.decision, "allow");
    assert.match(review.reason, /allowed \(degraded/);

    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-t", decision: "timeout", status: "timeout" }) };
    const timed = await decide({ toolName: "mcp__github__create_issue", toolInput: { title: "x" } }, opts);
    assert.equal(timed.decision, "deny");
    assert.match(timed.reason, /no decision within the approval window \(timed out\)/);

    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-a", decision: "approved", status: "approved" }) };
    const ok = await decide({ toolName: "mcp__github__create_issue", toolInput: { title: "x" } }, opts);
    assert.equal(ok.decision, "allow");
    assert.match(ok.reason, /Approved via OKed/);

    reply = { status: 401, headers: {}, body: JSON.stringify({ message: "API key required" }) };
    const auth = await decide({ toolName: "mcp__github__create_issue", toolInput: { title: "x" } }, opts);
    assert.equal(auth.decision, "deny");
    assert.match(auth.reason, /invalid API key \(HTTP 401\)/);

    process.env.OKED_API_KEY = "";
    const unpairedUnknown = await decide({ toolName: "NotARealTool", toolInput: { value: 1 } }, opts);
    assert.equal(unpairedUnknown.decision, "deny");
    assert.match(unpairedUnknown.reason, /Pair first: run oked init/);
    assert.equal(classify("NotARealTool", { value: 1 }), "review");
    passed++;
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log(`ok - @oked/hook-core: ${passed}/6 passed`);
