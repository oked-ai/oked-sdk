import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";

const {
  INSTALL_PING_PATH,
  sendAnonymousInstallPing,
  telemetryEnabled,
} = await import("../dist/install-ping.js");

assert.equal(telemetryEnabled({}), true);
assert.equal(telemetryEnabled({ OKED_TELEMETRY: "0" }), false);
assert.equal(telemetryEnabled({ OKED_TELEMETRY: "false" }), false);
assert.equal(telemetryEnabled({ OKED_TELEMETRY: "off" }), false);
assert.equal(telemetryEnabled({ OKED_TELEMETRY: "1" }), true);

const dir = mkdtempSync(path.join(tmpdir(), "oked-install-ping-"));
const stateFile = path.join(dir, "openclaw-install.json");
const seen = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  seen.push({
    url: req.url,
    method: req.method,
    authorization: req.headers.authorization,
    body: raw ? JSON.parse(raw) : null,
    statusToSend: seen.length === 0 ? 500 : 200,
  });
  const status = seen[seen.length - 1].statusToSend;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const backendUrl = `http://127.0.0.1:${port}`;

try {
  const skipped = await sendAnonymousInstallPing({
    backendUrl,
    pluginVersion: "0.6.27",
    openclawVersion: "2026.11.6",
    stateFile,
    env: { OKED_TELEMETRY: "0" },
  });
  assert.equal(skipped, undefined);
  assert.equal(seen.length, 0);

  const failed = await sendAnonymousInstallPing({
    backendUrl,
    pluginVersion: "0.6.27",
    openclawVersion: "2026.11.6",
    stateFile,
    env: {},
  });
  assert.equal(failed.client_type, "openclaw");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, INSTALL_PING_PATH);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].authorization, undefined);
  assert.deepEqual(Object.keys(seen[0].body).sort(), [
    "client_type",
    "install_id",
    "openclaw_version",
    "plugin_version",
  ]);
  assert.equal(seen[0].body.client_type, "openclaw");
  assert.equal(seen[0].body.plugin_version, "0.6.27");
  assert.equal(seen[0].body.openclaw_version, "2026.11.6");
  assert.match(seen[0].body.install_id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(seen[0].body).includes("hostname"), false);

  const sent = await sendAnonymousInstallPing({
    backendUrl,
    pluginVersion: "0.6.27",
    openclawVersion: "2026.11.6",
    stateFile,
    env: {},
  });
  assert.equal(sent.install_id, failed.install_id);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].body.install_id, seen[0].body.install_id);

  const again = await sendAnonymousInstallPing({
    backendUrl,
    pluginVersion: "0.6.27",
    openclawVersion: "2026.11.6",
    stateFile,
    env: {},
  });
  assert.equal(again, undefined);
  assert.equal(seen.length, 2);

  const unknown = await sendAnonymousInstallPing({
    backendUrl,
    pluginVersion: "0.6.27",
    openclawVersion: "",
    stateFile: path.join(dir, "other.json"),
    env: {},
  });
  assert.equal(unknown.openclaw_version, "unknown");

  console.log("OK anonymous install ping");
} finally {
  server.close();
}
