// Offline smoke test — no network, no API key. Verifies the callback's
// local decision paths (safe → allow; missing key → ask). Run via
// `npm test` (builds first, then executes against dist/).
import assert from "node:assert";
import { okedPreToolUseHook, okedHooks } from "../dist/index.js";

function mkInput(tool_name, tool_input) {
  return { hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", cwd: "/tmp" };
}

let passed = 0;

// Safe tool → allow ({}), no network/key needed.
{
  const out = await okedPreToolUseHook(mkInput("Read", { file_path: "/tmp/x" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(out, {}, "safe tool should allow with {}");
  passed++;
}

// Unknown/sensitive tool with no OKED_API_KEY → defer to native prompt (ask).
// Use a genuinely prompt-worthy command: `git push` is high_stakes. (A /tmp
// deletion would be `warning` — the ephemeral-temp downgrade — and short-circuit
// to allow before the missing-key branch, so it can't exercise this path.)
{
  delete process.env.OKED_API_KEY;
  const out = await okedPreToolUseHook(mkInput("Bash", { command: "git push origin main" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(
    out?.hookSpecificOutput?.permissionDecision,
    "ask",
    "sensitive tool without API key should defer (ask)",
  );
  passed++;
}

// okedHooks() shape is spreadable into options.hooks.
{
  const h = okedHooks();
  assert.ok(Array.isArray(h.PreToolUse) && typeof h.PreToolUse[0].hooks[0] === "function",
    "okedHooks() should return { PreToolUse: [{ hooks: [fn] }] }");
  passed++;
}

console.log(`ok - @oked/claude-agent-sdk smoke: ${passed}/3 passed`);
