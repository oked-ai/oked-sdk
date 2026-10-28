// Offline CLI test — a local mock backend, a temporary HOME and project folder.
// Covers `oked init --key-only` (create or show the key, add no hook) and that
// a plain `oked init` still installs the hook. `--no-browser` keeps the test
// from opening a browser or touching the clipboard.
// Run via `npm test` (builds first).
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oked.js");
const NEW_KEY = "oked_test_NEWKEY_FULL_SECRET_0123456789";

const calls = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push(`${req.method} ${req.url}`);
    const json = (status, obj) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
    if (req.url === "/health") return json(200, { status: "ok" });
    if (req.url === "/api/v1/device/code") {
      assert.equal(JSON.parse(body).client_type, "sdk", "key-only pairs as an sdk client");
      return json(200, {
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_uri: "https://example.test/pair",
        verification_uri_complete: "https://example.test/pair?code=ABCD-1234",
        interval: 1,
        expires_in: 30,
      });
    }
    if (req.url === "/api/v1/device/poll") return json(200, { status: "approved", api_key: NEW_KEY });
    return json(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const backend = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), "oked-cli-test-"));
const home = join(root, "home");
const project = join(root, "project");
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(project);
const userSettings = join(home, ".claude", "settings.json");
const userSettingsBefore = JSON.stringify(
  { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "oked-hook", timeout: 300 }] }] } },
  null,
  2,
);
writeFileSync(userSettings, userSettingsBefore);

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: home, OKED_BACKEND_URL: backend, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end();
  });
}

let passed = 0;
const config = join(home, ".oked", "config.json");
try {
  // 1. Not paired: --key-only pairs, saves the key (mode 600), adds no hook.
  {
    const { code, out } = await runCli(["init", "--key-only", "--no-browser"]);
    assert.equal(code, 0);
    assert.match(out, /Paired ✓  API key oked_tes\.\.\. saved to /);
    assert.match(out, /No Claude Code hook was added/);
    assert.match(out, /^  Open this link:$/m, "--no-browser opens no browser");
    assert.doesNotMatch(out, /Couldn't open your browser/, "--no-browser tried no browser");
    assert.ok(!out.includes(NEW_KEY), "the full key is never printed");
    const saved = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(saved.apiKey, NEW_KEY);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.ok(!existsSync(join(project, ".claude")), "no project hook");
    assert.equal(readFileSync(userSettings, "utf8"), userSettingsBefore, "user settings untouched");
    assert.ok(calls.includes("POST /api/v1/device/code") && calls.includes("POST /api/v1/device/poll"));
    passed++;
  }

  // 2. Already paired: --key-only shows the key (masked) and where it is. No pairing.
  {
    calls.length = 0;
    const { code, out } = await runCli(["init", "--key-only"]);
    assert.equal(code, 0);
    assert.match(out, /already set up \(no hook added\)/);
    assert.match(out, /API key: oked_tes\.\.\./);
    assert.ok(out.includes(`Stored in: ${config}`));
    assert.match(out, /\(connected\)/);
    assert.ok(!out.includes(NEW_KEY));
    assert.ok(!calls.some((c) => c.includes("/device/")), "no new pairing");
    assert.ok(!existsSync(join(project, ".claude")));
    assert.equal(readFileSync(userSettings, "utf8"), userSettingsBefore);
    passed++;
  }

  // 3. A key from the environment: says so.
  {
    const { out } = await runCli(["init", "--key-only"], { OKED_API_KEY: "oked_env_KEY_9999999999" });
    assert.match(out, /API key: oked_env\.\.\./);
    assert.match(out, /Stored in: the OKED_API_KEY environment variable/);
    passed++;
  }

  // 4. A plain `oked init` still installs the project hook and upgrades the user entry.
  {
    const { code, out } = await runCli(["init"]);
    assert.equal(code, 0);
    assert.match(out, /OKed hook installed/);
    const projectSettings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
    assert.ok(JSON.stringify(projectSettings).includes("oked-hook"));
    const user = JSON.parse(readFileSync(userSettings, "utf8"));
    assert.equal(user.hooks.PreToolUse[0].hooks[0].timeout, 690);
    passed++;
  }

  // 5. The pairing QR code: the right size and fixed patterns, and only in a terminal.
  {
    const { encodeQR, renderQR } = await import("../dist/qr.js");
    const url = "https://oked.ai/pair?code=ABCD-EF23";
    const m = encodeQR(url);
    assert.equal(m.length, 29, "a pairing link fits version 3");
    const finderRow = [true, true, true, true, true, true, true, false];
    assert.deepEqual(m[0].slice(0, 8), finderRow, "top-left finder");
    assert.deepEqual(m[0].slice(-7), finderRow.slice(0, 7), "top-right finder");
    assert.equal(m[m.length - 8][8], true, "the dark module");
    for (let i = 8; i < m.length - 8; i++) assert.equal(m[6][i], i % 2 === 0, "timing pattern");
    // Format bits (top-left copy) must be a valid level M word.
    let bits = 0;
    for (let i = 0; i <= 5; i++) bits |= (m[i][8] ? 1 : 0) << i;
    bits |= (m[7][8] ? 1 : 0) << 6;
    bits |= (m[8][8] ? 1 : 0) << 7;
    bits |= (m[8][7] ? 1 : 0) << 8;
    for (let i = 9; i < 15; i++) bits |= (m[8][14 - i] ? 1 : 0) << i;
    const data = (bits ^ 0x5412) >>> 10;
    assert.equal(data >>> 3, 0, "error correction level M");
    assert.throws(() => encodeQR("x".repeat(300)), /too long/);
    const lines = renderQR(url).split("\n");
    assert.equal(lines.length, 17, "two modules per line, with a 2-module quiet zone");
    assert.ok(lines.every((l) => l.includes("\x1b[30;107m")), "black on white");
    // The CLI runs here without a terminal, so it prints no QR code.
    const { out } = await runCli(["init", "--key-only"]);
    assert.doesNotMatch(out, /scan this/i);
    passed++;
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`ok - @oked/claude-code cli: ${passed}/5 passed`);
