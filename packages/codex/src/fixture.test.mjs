// Pipes sample Codex PreToolUse payloads into the hook binary against a mock API.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-codex-hook.js");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "pre-tool-use.json");
const cases = JSON.parse(readFileSync(FIXTURES, "utf8"));
const home = mkdtempSync(join(tmpdir(), "oked-codex-fx-"));

const replies = {
  denied: { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-d", decision: "denied", status: "denied" }) },
  approved: { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-a", decision: "approved", status: "approved" }) },
  timeout: { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-t", decision: "timeout", status: "timeout" }) },
  unreachable: { status: 404, headers: { "x-railway-fallback": "true" }, body: JSON.stringify({ message: "Application not found" }) },
};

let reply = replies.denied;
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
    res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers }).end(reply.body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const backend = `http://127.0.0.1:${server.address().port}`;

function run(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: home,
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
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

let passed = 0;
try {
  for (const item of cases) {
    reply = replies[item.mock] || replies.denied;
    const { code, stdout } = await run(item.input, { OKED_API_KEY: item.apiKey || "" });
    assert.equal(code, 0, item.name);
    if (item.expect.stdout !== undefined) {
      assert.equal(stdout, item.expect.stdout, item.name);
    } else {
      const out = JSON.parse(stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, item.expect.permissionDecision, item.name);
      assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(item.expect.reasonIncludes), item.name);
      assert.ok(!stdout.includes('"allow"'), item.name);
    }
    passed++;
  }
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(`ok - @oked/codex fixtures: ${passed}/${cases.length} passed`);
