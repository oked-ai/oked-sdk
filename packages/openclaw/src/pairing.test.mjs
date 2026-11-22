import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "oked-pair-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.OKED_API_KEY;
delete process.env.OKED_TELEMETRY;

const {
  beginDevicePairing,
  persistPairedApiKey,
  unpairedDenyReason,
} = await import("../dist/pairing.js");
const { default: plugin } = await import("../dist/index.js");

assert.match(unpairedDenyReason({ phase: "pending", pairUrl: "https://app.oked.ai/pair?code=ABCD", userCode: "ABCD" }), /OKed is not set up yet/);
assert.match(unpairedDenyReason({ phase: "pending", pairUrl: "https://app.oked.ai/pair?code=ABCD", userCode: "ABCD" }), /https:\/\/app\.oked\.ai\/pair\?code=ABCD/);
assert.match(unpairedDenyReason({ phase: "unavailable" }), /npx @oked\/openclaw-cli init/);
assert.match(unpairedDenyReason({ phase: "expired", pairUrl: "https://app.oked.ai/pair?code=ABCD", userCode: "ABCD" }), /expired/);

{
  const dir = mkdtempSync(path.join(tmpdir(), "oked-persist-"));
  const openclawFile = path.join(dir, ".openclaw", "openclaw.json");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(dir, ".openclaw"), { recursive: true });
  writeFileSync(
    openclawFile,
    JSON.stringify({
      plugins: { allow: ["voice-call"], entries: { oked: { extra: 1 } } },
    }),
  );
  const saved = persistPairedApiKey("ok_saved", "https://api.oked.ai", dir);
  assert.equal(saved.savedOkedConfig, true);
  assert.equal(saved.savedOpenClawConfig, true);
  const oked = JSON.parse(readFileSync(path.join(dir, ".oked", "config.json"), "utf8"));
  assert.equal(oked.apiKey, "ok_saved");
  assert.equal(oked.backendUrl, "https://api.oked.ai");
  const cfg = JSON.parse(readFileSync(openclawFile, "utf8"));
  assert.deepEqual(cfg.plugins.allow, ["voice-call", "oked"]);
  assert.equal(cfg.plugins.entries.oked.apiKey, "ok_saved");
  assert.equal(cfg.plugins.entries.oked.enabled, true);
  assert.equal(cfg.plugins.entries.oked.extra, 1);
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    assert.equal(statSync(path.join(dir, ".oked", "config.json")).mode & 0o777, 0o600);
  }

  const brokenHome = mkdtempSync(path.join(tmpdir(), "oked-persist-bad-"));
  mkdirSync(path.join(brokenHome, ".openclaw"), { recursive: true });
  const badFile = path.join(brokenHome, ".openclaw", "openclaw.json");
  writeFileSync(badFile, "{not json");
  chmodSync(badFile, 0o600);
  const skipped = persistPairedApiKey("ok_saved", "https://api.oked.ai", brokenHome);
  assert.equal(skipped.savedOkedConfig, true);
  assert.equal(skipped.savedOpenClawConfig, false);
  assert.equal(readFileSync(badFile, "utf8"), "{not json");
}

{
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/api/v1/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          interval: 3,
          expires_in: 30,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    polls += 1;
    if (polls === 1) {
      return new Response("", { status: 410 });
    }
    return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
  };
  const logs = [];
  const session = beginDevicePairing({
    backendUrl: "https://api.oked.ai/",
    clientVersion: "0.6.27",
    hostname: "box",
    log: (line) => logs.push(line),
    onApproved: () => {
      throw new Error("should not approve");
    },
    fetchImpl,
    pollIntervalMs: 15,
  });
  const keepAlive = setInterval(() => {}, 50);
  try {
    await session.ready;
    assert.equal(session.state.pairUrl, "https://app.oked.ai/pair?code=ABCD-EFGH");
    assert.equal(session.state.userCode, "ABCD-EFGH");
    assert.match(logs.join("\n"), /https:\/\/app\.oked\.ai\/pair\?code=ABCD-EFGH/);
    assert.match(logs.join("\n"), /ABCD-EFGH/);
    await session.settled;
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(session.state.phase, "expired");
  assert.equal(calls.filter((call) => call.url.endsWith("/api/v1/device/code")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/v1/device/poll")).length, 1);
  assert.equal(calls[0].body.client_type, "openclaw");
  assert.equal(calls[0].body.client_version, "0.6.27");
  assert.equal(calls[0].body.hostname, "box");
  console.log("OK pairing session reuses one code until it expires");
}

{
  const requests = [];
  let polls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    if (req.url === "/api/v1/install") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/api/v1/device/code") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          device_code: "device-live",
          user_code: "WXYZ-1234",
          verification_uri_complete: "https://app.oked.ai/pair?code=WXYZ-1234",
          interval: 1,
          expires_in: 60,
        }),
      );
      return;
    }
    if (req.url === "/api/v1/device/poll") {
      polls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          polls === 1
            ? { status: "pending" }
            : { status: "approved", api_key: "ok_paired" },
        ),
      );
      return;
    }
    if (req.url === "/api/v1/approve") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ approval_id: "ap_pair", decision: "denied", status: "denied" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const logs = [];
    const handlers = new Map();
    plugin.register({
      pluginConfig: { backendUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 },
      runtime: { version: "2026.11.6" },
      logger: {
        info: (message) => logs.push(["info", message]),
        warn: (message) => logs.push(["warn", message]),
        error: (message) => logs.push(["error", message]),
      },
      on: (name, handler) => handlers.set(name, handler),
    });
    const handler = handlers.get("before_tool_call");
    const event = { toolName: "imessage_send", params: { to: "+1", body: "hi" } };
    const first = await handler(event, { toolName: "imessage_send" });
    const second = await handler(event, { toolName: "imessage_send" });
    for (const result of [first, second]) {
      assert.equal(result.block, true);
      assert.match(result.blockReason, /OKed is not set up yet/);
      assert.match(result.blockReason, /https:\/\/app\.oked\.ai\/pair\?code=WXYZ-1234/);
      assert.match(result.blockReason, /npx @oked\/openclaw-cli init/);
    }
    const codeCalls = requests.filter((request) => request.url === "/api/v1/device/code");
    assert.equal(codeCalls.length, 1);
    assert.equal(codeCalls[0].body.client_type, "openclaw");
    const pingDeadline = Date.now() + 1500;
    let installCalls = requests.filter((request) => request.url === "/api/v1/install");
    while (installCalls.length === 0 && Date.now() < pingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      installCalls = requests.filter((request) => request.url === "/api/v1/install");
    }
    assert.equal(installCalls.length, 1, `install ping missing; saw ${requests.map((request) => request.url).join(", ")}`);
    assert.equal(installCalls[0].authorization, undefined);
    assert.deepEqual(Object.keys(installCalls[0].body).sort(), [
      "client_type",
      "install_id",
      "openclaw_version",
      "plugin_version",
    ]);
    assert.equal(installCalls[0].body.client_type, "openclaw");
    assert.equal(installCalls[0].body.plugin_version, "0.6.27");
    assert.equal(installCalls[0].body.openclaw_version, "2026.11.6");
    assert.equal(JSON.stringify(installCalls[0].body).includes("hostname"), false);
    const setupLogs = logs.filter(
      ([level, message]) => level === "warn" && String(message).includes("https://app.oked.ai/pair?code=WXYZ-1234"),
    );
    assert.equal(setupLogs.length, 1);

    const deadline = Date.now() + 4000;
    let savedKey = "";
    while (Date.now() < deadline && savedKey !== "ok_paired") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        savedKey = JSON.parse(readFileSync(path.join(home, ".oked", "config.json"), "utf8")).apiKey;
      } catch {
        savedKey = "";
      }
    }
    assert.equal(savedKey, "ok_paired");
    const openclaw = JSON.parse(readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
    assert.ok(openclaw.plugins.allow.includes("oked"));
    assert.equal(openclaw.plugins.entries.oked.apiKey, "ok_paired");

    const after = await handler(
      { toolName: "create_note", params: {} },
      { toolName: "create_note" },
    );
    const approve = requests.filter((request) => request.url === "/api/v1/approve");
    assert.ok(approve.length >= 1);
    assert.equal(approve[0].authorization, "Bearer ok_paired");
    assert.notEqual(after?.blockReason?.includes("not set up yet"), true);
    console.log("OK plugin pairing, install ping, and saved key");
  } finally {
    server.close();
  }
}
