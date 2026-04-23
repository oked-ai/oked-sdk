// Standalone smoke test — no test runner required.
// Runs the classifier against the exact pain points surfaced in the OKed
// signal DB for r/openclaw (iMessage rename, phone call skill, deploy site,
// shell reflex). All must classify as sensitive.
//
// Also exercises the plugin's `register()` function with a stub api so we
// confirm the before_tool_call handler wires up and makes the expected
// approval decisions.

import { strict as assert } from "node:assert";
import { classifyOpenClawTool } from "../dist/classify-openclaw.js";
import plugin from "../dist/index.js";

// --- classifier ---

const cases = [
  // The iMessage rename pain point — r/openclaw/1seh8wi
  // Touches a real personal account — high_stakes.
  ["rename_imessage_group", {}, "high_stakes"],
  ["imessage_send", { to: "+1...", body: "..." }, "high_stakes"],

  // ClawCall phone call — r/openclaw/1sj4x1b
  ["make_phone_call", { number: "+1..." }, "high_stakes"],
  ["phone_dial", {}, "high_stakes"],

  // Deploy — r/openclaw/1sdulyd
  ["deploy_site", {}, "high_stakes"],
  ["publish_release", {}, "high_stakes"],

  // Shell reflex — r/LocalLLaMA/1shl0vd
  ["bash", { command: "rm -rf ./dist" }, "high_stakes"],
  ["bash", { command: "ls -la" }, "safe"],
  ["bash", { command: "git push --force" }, "high_stakes"],

  // Safe tools — should never fire
  ["list_sessions", {}, "safe"],
  ["search_messages", { q: "hi" }, "safe"],
  ["read_file", {}, "safe"],

  // Warning tier (edit-like)
  ["create_note", {}, "warning"],
  ["update_profile", {}, "warning"],
];

for (const [name, input, expected] of cases) {
  const got = classifyOpenClawTool(name, input);
  assert.equal(
    got,
    expected,
    `classifier(${name}) expected ${expected} got ${got}`,
  );
}
console.log(`✓ classifier: ${cases.length} cases`);

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

// Case 1: missing apiKey → plugin warns and fail-safe denies sensitive calls.
{
  // Ensure env doesn't leak an apiKey into this case.
  delete process.env.OKED_API_KEY;
  const { api, handlers, logs } = makeStubApi({ apiKey: "" });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  assert.ok(handler, "before_tool_call handler registered");

  const result = await handler(
    { toolName: "imessage_send", params: { to: "+1", body: "hi" } },
    { toolName: "imessage_send", sessionKey: "agent:main:main" },
  );
  assert.equal(result?.block, true, "denied when backend unreachable");
  assert.match(result?.blockReason ?? "", /fail-safe|deny/i);
  assert.ok(
    logs.some(([lvl, m]) => lvl === "warn" && /apiKey/.test(m)),
    "warns about missing apiKey",
  );
  console.log("✓ plugin: fail-safe deny when no apiKey");
}

// Case 2: safe tool → passes through without calling backend.
{
  const { api, handlers } = makeStubApi({});
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  const result = await handler(
    { toolName: "read_file", params: { path: "README.md" } },
    { toolName: "read_file" },
  );
  assert.equal(result, undefined, "safe tool not blocked");
  console.log("✓ plugin: safe tool passes through");
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
  console.log("✓ plugin: alwaysAllow bypasses");
}

// Case 4: alwaysApprove forces approval on an otherwise-normal tool.
{
  const { api, handlers } = makeStubApi({ alwaysApprove: ["run_report"] });
  plugin.register(api);
  const handler = handlers.get("before_tool_call");
  const result = await handler(
    { toolName: "run_report", params: {} },
    { toolName: "run_report" },
  );
  // No apiKey → fail-safe deny.
  assert.equal(result?.block, true, "alwaysApprove forces approval");
  console.log("✓ plugin: alwaysApprove forces approval");
}

console.log("\nAll smoke tests passed.");
