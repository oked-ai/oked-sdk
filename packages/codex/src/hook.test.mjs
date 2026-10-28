// Runs the built hook the way Codex does: JSON on stdin, JSON or nothing on stdout.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-codex-hook.js");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-codex.js");
const home = mkdtempSync(join(tmpdir(), "oked-codex-hook-"));
const project = join(home, "proj");
const { mkdirSync } = await import("node:fs");
mkdirSync(project, { recursive: true });

let reply = { status: 200, body: "{}" };
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/api/v1/rules") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      return;
    }
    if (req.url === "/api/v1/heartbeat") {
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    res.writeHead(reply.status, { "Content-Type": "application/json" }).end(reply.body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const backend = `http://127.0.0.1:${server.address().port}`;

function run(bin, args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OKED_API_KEY: "",
        OKED_BACKEND_URL: backend,
        OKED_REQUIRE_RECEIPT: "0",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function payload(tool_name, tool_input) {
  return { session_id: "s1", cwd: project, hook_event_name: "PreToolUse", tool_name, tool_input };
}

let passed = 0;
try {
  {
    const { code, stdout } = await run(HOOK, [], payload("Bash", { command: "ls" }));
    assert.equal(code, 0);
    assert.equal(stdout, "", "an allow prints nothing, so Codex does not log an explicit allow");
    passed++;
  }
  {
    const { code, stdout, stderr } = await run(HOOK, [], payload("apply_patch", { command: "*** Update File: src/app.ts\n" }));
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /WARNING  OKed:/);
    passed++;
  }
  {
    const { code, stdout } = await run(HOOK, [], payload("custom_tool", { value: 1 }));
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Pair first: run oked-codex init/);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(!stdout.includes('"allow"'));
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], payload("Bash", { command: "rm -rf /var/data" }));
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Pair first: run oked-codex init/);
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], "not json");
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not be read/);
    passed++;
  }
  {
    reply = { status: 200, body: JSON.stringify({ approval_id: "appr-1", decision: "approved", status: "approved" }) };
    const { stdout } = await run(HOOK, [], payload("mcp__github__create_issue", { title: "x" }), { OKED_API_KEY: "test-key" });
    assert.equal(stdout, "", "an approval is not an explicit allow");
    passed++;
  }
  {
    reply = { status: 200, body: JSON.stringify({ approval_id: "appr-2", decision: "denied", status: "denied" }) };
    const { stdout } = await run(HOOK, [], payload("mcp__github__create_issue", { title: "x" }), { OKED_API_KEY: "test-key" });
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Denied via OKed/);
    passed++;
  }
  {
    const first = await run(CLI, ["init", "--no-browser"], undefined, { OKED_API_KEY: "oked_test_key_123456" });
    assert.equal(first.code, 0);
    assert.match(first.stdout, /OKed hook installed/);
    const second = await run(CLI, ["init"], undefined, { OKED_API_KEY: "oked_test_key_123456" });
    assert.match(second.stdout, /already configured/);
    const gone = await run(CLI, ["uninstall"]);
    assert.match(gone.stdout, /removed/);
    const again = await run(CLI, ["uninstall"]);
    assert.match(again.stdout, /not installed/);
    passed++;
  }
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(`ok - @oked/codex hook: ${passed}/8 passed`);
