// Runs the built hook the way Cursor does: JSON on stdin, JSON on stdout.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-cursor-hook.js");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-cursor.js");
const home = mkdtempSync(join(tmpdir(), "oked-cursor-hook-"));
const project = join(home, "proj");
mkdirSync(project, { recursive: true });

let reply = { status: 200, body: "{}" };
const urls = [];
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    urls.push(req.url);
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
  return { conversation_id: "c1", cwd: project, hook_event_name: "preToolUse", tool_name, tool_input };
}

let passed = 0;
try {
  {
    const { code, stdout } = await run(HOOK, [], payload("Read", { path: "README.md" }));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { permission: "allow" });
    passed++;
  }
  {
    const { stdout, stderr } = await run(HOOK, [], payload("Write", { path: "src/app.ts", contents: "hi" }));
    assert.deepEqual(JSON.parse(stdout), { permission: "allow" });
    assert.match(stderr, /WARNING  OKed:/);
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], payload("Shell", { command: "ls" }));
    assert.equal(JSON.parse(stdout).permission, "allow");
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], payload("CustomTool", { value: 1 }));
    const out = JSON.parse(stdout);
    assert.equal(out.permission, "deny");
    assert.match(out.user_message, /Pair first: run oked-cursor init/);
    assert.match(out.agent_message, /Pair first: run oked-cursor init/);
    assert.ok(!stdout.includes('"ask"'));
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], payload("Delete", { path: "src/app.ts" }));
    assert.equal(JSON.parse(stdout).permission, "deny");
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], payload("MCP:list_files", {}));
    assert.equal(JSON.parse(stdout).permission, "allow");
    passed++;
  }
  {
    const { stdout } = await run(HOOK, [], "not json");
    assert.equal(JSON.parse(stdout).permission, "deny");
    assert.match(JSON.parse(stdout).user_message, /could not be read/);
    passed++;
  }
  {
    reply = { status: 200, body: JSON.stringify({ approval_id: "appr-1", decision: "approved", status: "approved" }) };
    const { stdout } = await run(HOOK, [], payload("MCP:github:create_issue", { title: "x" }), { OKED_API_KEY: "test-key" });
    const out = JSON.parse(stdout);
    assert.equal(out.permission, "allow");
    assert.match(out.user_message, /Approved via OKed/);
    passed++;
  }
  {
    reply = { status: 200, body: JSON.stringify({ approval_id: "appr-2", decision: "denied", status: "denied" }) };
    const { stdout } = await run(HOOK, [], payload("MCP:github:create_issue", { title: "x" }), { OKED_API_KEY: "test-key" });
    const out = JSON.parse(stdout);
    assert.equal(out.permission, "deny");
    assert.match(out.agent_message, /^Denied via OKed/);
    passed++;
  }
  {
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "oked-hook" }] }] } }),
    );
    const skipped = await run(CLI, ["init", "--no-browser"], undefined, { OKED_API_KEY: "oked_test_key_123456" });
    assert.match(skipped.stdout, /would ask twice/);
    assert.equal(existsSync(join(project, ".cursor", "hooks.json")), false);
    const forced = await run(CLI, ["init", "--native"], undefined, { OKED_API_KEY: "oked_test_key_123456" });
    assert.match(forced.stdout, /OKed hook installed/);
    assert.match(forced.stdout, /asked twice/);
    const again = await run(CLI, ["init"], undefined, { OKED_API_KEY: "oked_test_key_123456" });
    assert.match(again.stdout, /already configured/);
    const gone = await run(CLI, ["uninstall"]);
    assert.match(gone.stdout, /removed/);
    assert.ok(existsSync(join(project, ".claude", "settings.json")), "uninstall leaves the Claude hook");
    const twice = await run(CLI, ["uninstall"]);
    assert.match(twice.stdout, /not installed/);
    passed++;
  }
  {
    urls.length = 0;
    const secret = "SECRETTOKEN";
    const { stdout } = await run(HOOK, [], payload("Delete", { path: `src/${secret}.ts` }), { OKED_MODE: "watch" });
    const out = JSON.parse(stdout);
    assert.equal(out.permission, "allow");
    assert.match(out.user_message, /would have paused \(not paired\)/);
    assert.ok(!urls.includes("/api/v1/approve"));
    const text = readFileSync(join(home, ".oked", "watch.log"), "utf8");
    assert.ok(!text.includes(secret));
    passed++;
  }
  {
    urls.length = 0;
    reply = { status: 200, body: JSON.stringify({ approval_id: "appr-w", decision: "denied", status: "denied" }) };
    const { stdout } = await run(HOOK, [], payload("MCP:github:create_issue", { title: "x" }), {
      OKED_API_KEY: "test-key",
      OKED_MODE: "enforce",
    });
    assert.equal(JSON.parse(stdout).permission, "deny");
    assert.ok(urls.includes("/api/v1/approve"));
    urls.length = 0;
    const watched = await run(HOOK, [], payload("MCP:github:create_issue", { title: "x" }), {
      OKED_API_KEY: "test-key",
      OKED_MODE: "watch",
    });
    assert.equal(JSON.parse(watched.stdout).permission, "allow");
    assert.ok(!urls.includes("/api/v1/approve"));
    passed++;
  }
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(`ok - @oked/cursor hook: ${passed}/12 passed`);
