// Offline hook test — a local mock backend, no real network, no real API key.
// Runs the built hook (bin/oked-hook.js) as Claude Code does: JSON in on stdin,
// JSON out on stdout. Checks the deny reasons (real error and HTTP status) and
// ~/.oked/hook.log (one line per decision that is not an allow).
// Run via `npm test` (builds first).
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-hook.js");
const SECRET = "SECRETTOKEN123";
const HIGH_STAKES = { tool_name: "Bash", tool_input: { command: `curl -X DELETE -H "Authorization: Bearer ${SECRET}" https://example.com/api` } };
const REVIEW = { tool_name: "mcp__github__create_issue", tool_input: { title: "x", body: SECRET } };

let reply = { status: 200, headers: {}, body: "{}" };
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/api/v1/rules" && reply.status < 300) {
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      return;
    }
    if (req.url === "/api/v1/heartbeat" && reply.status < 300) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
    res.end(reply.body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const backend = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const home = mkdtempSync(join(tmpdir(), "oked-hook-test-"));
const logPath = join(home, ".oked", "hook.log");

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OKED_API_KEY: "test-key",
        OKED_BACKEND_URL: backend,
        OKED_REQUIRE_RECEIPT: "0",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(out).hookSpecificOutput);
      } catch (e) {
        reject(new Error(`hook wrote no JSON: ${out}`));
      }
    });
    child.stdin.end(JSON.stringify({ session_id: "s1", cwd: home, hook_event_name: "PreToolUse", ...input }));
  });
}

const logLines = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

try {
  // Railway "Application not found": an outage. High stakes: deny, with the real cause.
  {
    reply = { status: 404, headers: { "x-railway-fallback": "true" }, body: JSON.stringify({ message: "Application not found" }) };
    const out = await runHook(HIGH_STAKES);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /backend unreachable/);
    assert.match(out.permissionDecisionReason, /HTTP 404/);
    assert.match(out.permissionDecisionReason, /application not found/i);
    assert.match(out.permissionDecisionReason, /high-stakes denied \(fail-safe\)/);
    const line = logLines().at(-1);
    assert.equal(line.decision, "deny");
    assert.equal(line.tool, "Bash");
    assert.equal(line.tier, "high_stakes");
    assert.equal(line.error.name, "OKedBackendUnreachableError");
    assert.equal(line.error.status, 404);
    passed++;
  }

  // The same outage for a review-tier action: the existing degraded mode allows it.
  // A degraded allow ran without a person's decision, so it is logged.
  {
    const before = logLines().length;
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "allow");
    assert.match(out.permissionDecisionReason, /unreachable \(.*HTTP 404.*\) - allowed \(degraded/);
    const lines = logLines();
    assert.equal(lines.length, before + 1, "a degraded allow is logged");
    assert.deepEqual([lines.at(-1).decision, lines.at(-1).degraded, lines.at(-1).tier], ["allow", true, "review"]);
    passed++;
  }

  // A reply that is not JSON (an HTML page with HTTP 200): an outage too.
  {
    reply = { status: 200, headers: { "Content-Type": "text/html" }, body: "<html>portal</html>" };
    const out = await runHook(HIGH_STAKES);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /HTTP 200 with a reply that is not JSON/);
    passed++;
  }

  // 429: a clear message that says what to do.
  {
    reply = { status: 429, headers: {}, body: JSON.stringify({ error: "too many pending approvals for this operator" }) };
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /too many approvals are waiting for your decision/);
    assert.match(out.permissionDecisionReason, /HTTP 429/);
    assert.equal(logLines().at(-1).error.name, "OKedTooManyPendingError");
    passed++;
  }

  // Any other HTTP error: the status and the backend's own text, not "unexpected error".
  {
    reply = { status: 400, headers: {}, body: JSON.stringify({ error: "action is required" }) };
    const out = await runHook(HIGH_STAKES);
    assert.equal(out.permissionDecision, "deny");
    assert.equal(out.permissionDecisionReason, "OKed: backend error HTTP 400: action is required (fail-safe deny)");
    passed++;
  }

  // A bad key: auth, with the status.
  {
    reply = { status: 401, headers: {}, body: JSON.stringify({ message: "API key required" }) };
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "deny");
    assert.equal(
      out.permissionDecisionReason,
      "OKed: invalid API key (HTTP 401). Run `oked init` to pair again, or `oked uninstall` to remove OKed.",
    );
    passed++;
  }

  // A person denied it: logged with the approval ID.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-1", decision: "denied", status: "denied" }) };
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^Denied via OKed/);
    const line = logLines().at(-1);
    assert.equal(line.approval_id, "appr-1");
    assert.equal(line.error, undefined);
    passed++;
  }

  // No decision in time: says so.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-2", decision: "timeout", status: "timeout" }) };
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /no decision within the approval window \(timed out\)/);
    passed++;
  }

  // Not paired: "ask", logged.
  {
    const out = await runHook(REVIEW, { OKED_API_KEY: "" });
    assert.equal(out.permissionDecision, "ask");
    assert.equal(logLines().at(-1).decision, "ask");
    passed++;
  }

  // A normal allow (approved) is not logged.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-3", decision: "approved", status: "approved" }) };
    const before = logLines().length;
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "allow");
    assert.equal(logLines().length, before, "a normal allow is not logged");
    passed++;
  }

  // The log: mode 600, one JSON line per deny, ask or degraded allow, no tool input.
  {
    const lines = logLines();
    assert.equal(lines.length, 9, "8 deny or ask decisions and 1 degraded allow above");
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    const text = readFileSync(logPath, "utf8");
    assert.ok(!text.includes(SECRET), "the log never holds tool input");
    assert.ok(!text.includes("curl -X DELETE"), "the log never holds the command");
    for (const l of lines) assert.ok(l.ts && l.decision && l.reason && l.client, "each line has ts, decision, reason, client");
    passed++;
  }
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(`ok - @oked/claude-code hook: ${passed}/11 passed`);
