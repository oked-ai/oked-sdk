// Runs the committed plugin bundle the way Claude Code runs the hook:
// JSON on stdin, JSON on stdout, no global npm install.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "plugins", "claude-code", "scripts", "oked-hook.mjs");
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(ROOT, "plugins", "claude-code", ".claude-plugin", "plugin.json"), "utf8"),
).version;

const REVIEW = { tool_name: "mcp__github__create_issue", tool_input: { title: "x", body: "y" } };
const FORCE = { tool_name: "Bash", tool_input: { command: "git push --force origin main" } };

let reply = { status: 200, body: JSON.stringify({ approval_id: "appr-1", decision: "denied", status: "denied" }) };
const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
    if (req.url === "/api/v1/rules") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      return;
    }
    if (req.url === "/api/v1/heartbeat") {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(reply.status, { "Content-Type": "application/json" }).end(reply.body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const backend = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), "oked-plugin-bundle-"));
const home = join(root, "home");
const project = join(root, "project");
const bin = join(root, "bin");
const install = join(ROOT, "plugins", "claude-code");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "oked-hook"), "");

function runBundle(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd: project,
      env: {
        PATH: `${bin}${delimiter}/usr/bin:/bin`,
        HOME: home,
        OKED_BACKEND_URL: backend,
        OKED_REQUIRE_RECEIPT: "0",
        ...env,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify({ session_id: "s1", cwd: project, hook_event_name: "PreToolUse", ...input }));
  });
}

function approvePosts() {
  return requests.filter((request) => request.method === "POST" && request.url === "/api/v1/approve");
}

let passed = 0;
try {
  {
    const { code, out } = await runBundle(["--help"]);
    assert.equal(code, 0);
    assert.match(out, /pair/);
    passed++;
  }

  {
    const before = approvePosts().length;
    const { code, out } = await runBundle([], REVIEW, { OKED_API_KEY: "", CLAUDE_PLUGIN_OPTION_APIKEY: "" });
    assert.equal(code, 0);
    const decision = JSON.parse(out).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "ask");
    assert.match(decision.permissionDecisionReason, /\/oked:pair/);
    assert.equal(approvePosts().length, before, "an unpaired plugin does not call OKed");
    passed++;
  }

  {
    const before = approvePosts().length;
    const { out } = await runBundle([], FORCE, {
      OKED_API_KEY: "env-key-should-not-win",
      CLAUDE_PLUGIN_OPTION_APIKEY: "plugin-key",
    });
    const decision = JSON.parse(out).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "deny");
    assert.match(decision.permissionDecisionReason, /^Denied via OKed/);
    assert.equal(approvePosts().length, before + 1);
    const post = approvePosts().at(-1);
    assert.equal(post.authorization, "Bearer plugin-key");
    const body = JSON.parse(post.body);
    assert.equal(body.client, `oked-plugin@${PLUGIN_VERSION}`);
    assert.equal(body.tier, "high_stakes");
    assert.equal(body.metadata.tool_input.command, "git push --force origin main");
    passed++;
  }

  {
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "oked-hook" }] }] },
      }),
    );
    const before = approvePosts().length;
    const stoodDown = await runBundle([], FORCE, { CLAUDE_PLUGIN_OPTION_APIKEY: "plugin-key" });
    assert.equal(JSON.parse(stoodDown.out).hookSpecificOutput.permissionDecision, "allow");
    assert.match(stoodDown.err, /standing down/);
    assert.equal(approvePosts().length, before, "settings hook is the only gate");
    const mcp = await runBundle([], REVIEW, { OKED_API_KEY: "", CLAUDE_PLUGIN_OPTION_APIKEY: "" });
    assert.equal(JSON.parse(mcp.out).hookSpecificOutput.permissionDecision, "ask");
    assert.equal(approvePosts().length, before, "MCP is outside the settings matcher and still unpaired");
    passed++;
  }

  {
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
    const { out, err } = await runBundle([], FORCE, { CLAUDE_PLUGIN_OPTION_APIKEY: "plugin-key" });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
    assert.doesNotMatch(err, /standing down/);
    assert.equal(approvePosts().length, before + 1, "the plugin gates when it is enabled");
    assert.equal(approvePosts().at(-1).authorization, "Bearer plugin-key");
    passed++;
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`ok - claude code plugin bundle: ${passed}/5 passed`);
