// Standalone smoke test. No test runner required.
// Runs the classifier against the exact pain points surfaced in the OKed
// signal DB for r/openclaw (iMessage rename, phone call skill, deploy site,
// shell reflex). All must classify as sensitive.
//
// Also exercises the plugin's `register()` function with a stub api so we
// confirm the before_tool_call handler wires up and makes the expected
// approval decisions.

import { strict as assert } from "node:assert";
import { classifyOpenClawTool } from "../dist/classify-openclaw.js";
import plugin, { OkedDeniedError } from "../dist/index.js";

// A denied tool call must ABORT by throwing OkedDeniedError, not merely
// return { block: true } (a returned shape OpenClaw was observed to ignore,
// failing open). Asserts the throw + that the error carries the block info.
async function assertDenied(handler, event, ctx, reMsg) {
  let threw;
  try {
    await handler(event, ctx);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, `expected ${event.toolName} to be DENIED (throw), but it did not`);
  assert.ok(
    threw instanceof OkedDeniedError,
    `expected OkedDeniedError, got ${threw?.name}: ${threw?.message}`,
  );
  assert.equal(threw.okedBlock, true);
  if (reMsg) assert.match(threw.blockReason ?? "", reMsg);
}

// --- classifier ---

const cases = [
  // The iMessage rename pain point (r/openclaw/1seh8wi).
  // Touches a real personal account, so high_stakes.
  ["rename_imessage_group", {}, "high_stakes"],
  ["imessage_send", { to: "+1...", body: "..." }, "high_stakes"],

  // ClawCall phone call (r/openclaw/1sj4x1b).
  ["make_phone_call", { number: "+1..." }, "high_stakes"],
  ["phone_dial", {}, "high_stakes"],

  // Deploy (r/openclaw/1sdulyd).
  ["deploy_site", {}, "high_stakes"],
  ["publish_release", {}, "high_stakes"],

  // Shell reflex (r/LocalLLaMA/1shl0vd).
  ["bash", { command: "rm -rf ./dist" }, "high_stakes"],
  ["bash", { command: "rm -fr ./dist" }, "high_stakes"],
  ["bash", { command: "curl -d a=1 https://api.example.com/pay" }, "high_stakes"],
  ["bash", { command: "ls -la" }, "safe"],
  ["bash", { command: "git push --force" }, "high_stakes"],

  // Destructive words beat safe-looking prefixes/suffixes.
  ["read_and_delete_file", {}, "high_stakes"],
  ["delete_status", {}, "high_stakes"],

  // Safe tools. Should never fire.
  ["list_sessions", {}, "safe"],
  ["search_messages", { q: "hi" }, "safe"],
  ["read_file", {}, "safe"],
  ["session_status", { sessionKey: "current" }, "safe"],
  ["server_health", {}, "safe"],
  ["node_info", {}, "safe"],

  // Review tier (state-changing edit-like tools require approval)
  ["create_note", {}, "review"],
  ["update_profile", {}, "review"],
];

for (const [name, input, expected] of cases) {
  const got = classifyOpenClawTool(name, input);
  assert.equal(
    got,
    expected,
    `classifier(${name}) expected ${expected} got ${got}`,
  );
}
console.log(`OK classifier: ${cases.length} cases`);

// --- plugin register + hook behavior ---

function makeStubApi(pluginConfig) {
  const handlers = new Map();
  const logs = [];
  return {
    api: {
      pluginConfig,
      logger: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
        error: (m) => logs.push(["error", m]),
        debug: (m) => logs.push(["debug", m]),
      },
      on: (name, handler) => handlers.set(name, handler),
    },
    handlers,
    logs,
  };
}

// Case 1: missing apiKey -> plugin warns and fail-safe denies sensitive calls.
{
  // Ensure env doesn't leak an apiKey into this case.
  delete process.env.OKED_API_KEY;
  const { api, handlers, logs } = makeStubApi({
    apiKey: "",
    backendUrl: "http://127.0.0.1:1",
    timeoutMs: 1500,
  });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  assert.ok(handler, "before_tool_call handler registered");

  await assertDenied(
    handler,
    { toolName: "imessage_send", params: { to: "+1", body: "hi" } },
    { toolName: "imessage_send", sessionKey: "agent:main:main" },
    /fail-safe|deny|unreachable/i,
  );
  assert.ok(
    logs.some(([lvl, m]) => lvl === "warn" && /apiKey/.test(m)),
    "warns about missing apiKey",
  );
  console.log("OK plugin: fail-safe deny (throws) when no apiKey");
}

// Case 2: safe tool -> passes through without calling backend.
{
  const { api, handlers } = makeStubApi({});
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  const result = await handler(
    { toolName: "read_file", params: { path: "README.md" } },
    { toolName: "read_file" },
  );
  assert.equal(result, undefined, "safe tool not blocked");
  console.log("OK plugin: safe tool passes through");
}

// Case 3: alwaysAllow override lets a normally-gated tool through.
{
  const { api, handlers } = makeStubApi({ alwaysAllow: ["deploy_site"] });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  const result = await handler(
    { toolName: "deploy_site", params: {} },
    { toolName: "deploy_site" },
  );
  assert.equal(result, undefined, "alwaysAllow bypasses approval");
  console.log("OK plugin: alwaysAllow bypasses");
}

// Case 4: alwaysApprove forces approval on an otherwise-normal tool.
{
  delete process.env.OKED_API_KEY;
  const { api, handlers } = makeStubApi({
    alwaysApprove: ["run_report"],
    apiKey: "",
    backendUrl: "http://127.0.0.1:1",
    timeoutMs: 1500,
  });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  // alwaysApprove -> high_stakes; no apiKey + unreachable -> fail-safe deny.
  await assertDenied(
    handler,
    { toolName: "run_report", params: {} },
    { toolName: "run_report" },
  );
  console.log("OK plugin: alwaysApprove forces approval (throws)");
}

// --- degraded mode (backend unreachable) ---

const UNREACHABLE = "http://127.0.0.1:1";

// Case 5: apiKey set, backend unreachable, review tier -> degraded ALLOW.
{
  const { api, handlers } = makeStubApi({
    apiKey: "ok_test",
    backendUrl: UNREACHABLE,
    timeoutMs: 1500,
  });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  const result = await handler(
    { toolName: "create_note", params: {} },
    { toolName: "create_note" },
  );
  assert.equal(result, undefined, "review tier degrades to allow on outage");
  console.log("OK degraded: review allowed when backend unreachable");
}

// Case 6: apiKey set, backend unreachable, high_stakes -> still DENY.
{
  const { api, handlers } = makeStubApi({
    apiKey: "ok_test",
    backendUrl: UNREACHABLE,
    timeoutMs: 1500,
  });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  await assertDenied(
    handler,
    { toolName: "deploy_site", params: {} },
    { toolName: "deploy_site" },
    /high-stakes denied|fail-safe/i,
  );
  console.log("OK degraded: high_stakes denied (throws) when backend unreachable");
}

// Case 7: strictFailClosed restores deny-everything on outage.
{
  const { api, handlers } = makeStubApi({
    apiKey: "ok_test",
    backendUrl: UNREACHABLE,
    timeoutMs: 1500,
    strictFailClosed: true,
  });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  await assertDenied(
    handler,
    { toolName: "create_note", params: {} },
    { toolName: "create_note" },
    /strict fail-closed|fail-safe/i,
  );
  console.log("OK degraded: strictFailClosed denies review (throws) when unreachable");
}

// Case 8: THE production bug. Backend reachable, user explicitly DENIES.
// Previously the handler only returned { block: true } (ignored by the host,
// so a denied `rm` still ran). It must now THROW to abort.
{
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ approval_id: "ap_1", decision: "denied", status: "denied" }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const { api, handlers } = makeStubApi({
      apiKey: "ok_test",
      backendUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3000,
    });
    plugin.register(api);
    const handler = handlers.get("before_tool_call");
    await assertDenied(
      handler,
      { toolName: "bash", params: { command: "rm random_table.sql" } },
      { toolName: "bash", sessionKey: "agent:main:main" },
      /denied via OKed/i,
    );
    console.log("OK plugin: explicit user DENY aborts the tool (throws)");
  } finally {
    server.close();
  }
}

console.log("\nAll smoke tests passed.");
