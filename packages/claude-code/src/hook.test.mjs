// Offline hook test — a local mock backend, no real network, no real API key.
// Runs the built hook (bin/oked-hook.js) as Claude Code does: JSON in on stdin,
// JSON out on stdout. Checks the deny reasons (real error and HTTP status) and
// ~/.oked/hook.log (one line per decision that is not an allow).
// Run via `npm test` (builds first).
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked-hook.js");
const SECRET = "SECRETTOKEN123";
const HIGH_STAKES = { tool_name: "Bash", tool_input: { command: `curl -X DELETE -H "Authorization: Bearer ${SECRET}" https://example.com/api` } };
const REVIEW = { tool_name: "mcp__github__create_issue", tool_input: { title: "x", body: SECRET } };

let reply = { status: 200, headers: {}, body: "{}" };
const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, body });
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

  const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, ...extra });
  const approvePosts = () => requests.filter((r) => r.method === "POST" && r.url === "/api/v1/approve");
  const FORCE = bash("git push --force origin main");

  // A safe read-only command is allowed, and no approval request is sent.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "nope", decision: "approved", status: "approved" }) };
    const before = approvePosts().length;
    const out = await runHook(bash("cat README.md"));
    assert.equal(out.permissionDecision, "allow");
    assert.equal(out.permissionDecisionReason, undefined);
    assert.equal(approvePosts().length, before, "a read-only command does not ask");
    passed++;
  }

  // `rm -rf build` deletes build output. That tier is warning: allow, no approval.
  {
    const before = approvePosts().length;
    const out = await runHook(bash("rm -rf build"));
    assert.equal(out.permissionDecision, "allow");
    assert.equal(out.permissionDecisionReason, undefined);
    assert.equal(approvePosts().length, before, "rm -rf build does not ask");
    passed++;
  }

  // A force push asks, and an approval allows it.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-force-ok", decision: "approved", status: "approved" }) };
    const before = approvePosts().length;
    const out = await runHook(FORCE);
    assert.equal(out.permissionDecision, "allow");
    assert.match(out.permissionDecisionReason, /^Approved via OKed/);
    assert.equal(approvePosts().length, before + 1);
    const body = JSON.parse(approvePosts().at(-1).body);
    assert.equal(body.action, "Bash");
    assert.equal(body.tier, "high_stakes");
    assert.equal(body.metadata.tool_input.command, "git push --force origin main");
    assert.match(body.client, /^@oked\/claude-code@/);
    passed++;
  }

  // The same command is blocked when the person denies it.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-force-no", decision: "denied", status: "denied" }) };
    const out = await runHook(FORCE);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^Denied via OKed: /);
    passed++;
  }

  // No decision in time blocks the command.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-force-to", decision: "timeout", status: "timeout" }) };
    const out = await runHook(FORCE);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /no decision within the approval window \(timed out\)/);
    passed++;
  }

  // The API is unreachable. A high-stakes command fails closed.
  {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    const port = closed.address().port;
    await new Promise((r) => closed.close(r));
    const out = await runHook(FORCE, { OKED_BACKEND_URL: `http://127.0.0.1:${port}` });
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /backend unreachable/);
    assert.match(out.permissionDecisionReason, /high-stakes denied \(fail-safe\)/);
    passed++;
  }

  // permission_mode bypassPermissions (what --dangerously-skip-permissions sends)
  // still gates a risky command.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-bypass", decision: "denied", status: "denied" }) };
    const before = approvePosts().length;
    const out = await runHook({ ...FORCE, permission_mode: "bypassPermissions" });
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^Denied via OKed: /);
    assert.equal(approvePosts().length, before + 1, "bypassPermissions still asks");
    const body = JSON.parse(approvePosts().at(-1).body);
    assert.equal(body.tier, "high_stakes");
    assert.equal(body.metadata.tool_input.command, "git push --force origin main");
    passed++;
  }

  // A missing tool_input must stay a fail-safe deny. Coercing it to {} would
  // classify Bash as safe and allow the call.
  {
    const out = await runHook({ tool_name: "Bash" });
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /internal error \(fail-safe\)/);
    const read = await runHook({ tool_name: "Read" });
    assert.equal(read.permissionDecision, "deny");
    assert.match(read.permissionDecisionReason, /internal error \(fail-safe\)/);
    passed++;
  }

  // The Claude Code plugin is enabled and its hook file is on disk.
  // This settings hook must not call OKed. The plugin gates.
  {
    const install = join(home, "plugin-install");
    mkdirSync(join(install, "scripts"), { recursive: true });
    writeFileSync(join(install, "scripts", "oked-hook.mjs"), "// plugin hook\n");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "oked@oked": [{ installPath: install }] } }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "oked@oked": true } }),
    );
    const before = approvePosts().length;
    const out = await runHook(REVIEW);
    assert.equal(out.permissionDecision, "allow");
    assert.equal(out.permissionDecisionReason, undefined);
    assert.equal(approvePosts().length, before, "settings hook does not ask when the plugin gates");
    passed++;
  }

  // The plugin test above leaves the plugin enabled. Turn it off so these
  // cases exercise the settings hook again.
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { "oked@oked": false } }),
  );

  // Watch mode allows the same high-stakes call and does not post it for approval.
  {
    const before = approvePosts().length;
    const out = await runHook(HIGH_STAKES, { OKED_MODE: "watch" });
    assert.equal(out.permissionDecision, "allow");
    assert.match(out.permissionDecisionReason, /OKed watch: would have paused$/);
    assert.equal(approvePosts().length, before, "watch mode does not call approve");
    const text = readFileSync(join(home, ".oked", "watch.log"), "utf8");
    assert.ok(!text.includes(SECRET));
    const line = JSON.parse(text.trim().split("\n").at(-1));
    assert.equal(line.outcome, "would_have_paused");
    assert.equal(line.tool, "Bash");
    assert.equal(line.tier, "high_stakes");
    assert.equal(line.reason, "would have paused");
    passed++;
  }

  // A safe command in watch mode is not recorded as something that would have paused.
  {
    const before = readFileSync(join(home, ".oked", "watch.log"), "utf8");
    const out = await runHook({ tool_name: "Bash", tool_input: { command: "ls" } }, { OKED_MODE: "watch" });
    assert.equal(out.permissionDecision, "allow");
    assert.equal(out.permissionDecisionReason, undefined);
    assert.equal(readFileSync(join(home, ".oked", "watch.log"), "utf8"), before);
    passed++;
  }

  // Enforce mode still pauses. This request is denied by the mock.
  {
    reply = { status: 200, headers: {}, body: JSON.stringify({ approval_id: "appr-enf", decision: "denied", status: "denied" }) };
    const before = approvePosts().length;
    const out = await runHook(HIGH_STAKES, { OKED_MODE: "enforce" });
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^Denied via OKed/);
    assert.equal(approvePosts().length, before + 1);
    passed++;
  }

  assert.equal(passed, 23);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(`ok - @oked/claude-code hook: ${passed}/23 passed`);
