// Offline smoke test — no network, no API key. Covers the settings.json hook
// entry: the timeout nesting invariant, and the in-place upgrades `oked init`
// applies to an existing entry. Run via `npm test` (builds first, then
// executes against dist/).
import assert from "node:assert";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "@oked/sdk";
import {
  HOOK_CONFIG,
  HOOK_TIMEOUT_SECONDS,
  ensureHookTimeout,
  ensureMcpMatcher,
  hasOkedCommandHook,
} from "../dist/hook-config.js";

let passed = 0;

// The invariant this whole file exists to protect. Claude Code kills the hook
// process at HOOK_TIMEOUT_SECONDS; a killed process writes no JSON, so the
// harness falls back to its own default instead of honoring our fail-safe
// deny. The SDK's own abort has to fire first, with room for the pre-approve
// heartbeat() and getRules() calls.
{
  assert.ok(
    HOOK_TIMEOUT_SECONDS * 1000 > DEFAULT_APPROVAL_TIMEOUT_MS,
    "hook timeout must exceed the SDK approval timeout, or the fail-safe deny is never written",
  );
  assert.ok(
    HOOK_TIMEOUT_SECONDS * 1000 - DEFAULT_APPROVAL_TIMEOUT_MS >= 30_000,
    "margin must cover process spawn + heartbeat() + getRules() before approve()",
  );
  passed++;
}

// The entry a fresh `oked init` writes.
{
  const hook = HOOK_CONFIG.hooks.find((h) => h.command === "oked-hook");
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS, "fresh install should carry the current timeout");
  assert.ok(hasOkedCommandHook(HOOK_CONFIG), "HOOK_CONFIG should be recognized as ours");
  passed++;
}

// Existing install on the old 300s window gets raised in place.
{
  const entry = { matcher: "Bash", hooks: [{ type: "command", command: "oked-hook", timeout: 300 }] };
  assert.equal(ensureHookTimeout(entry), true, "stale timeout should report a change");
  assert.equal(entry.hooks[0].timeout, HOOK_TIMEOUT_SECONDS, "stale timeout should be raised");
  assert.equal(ensureHookTimeout(entry), false, "re-running should be a no-op");
  passed++;
}

// A deliberately longer window is the user's call — never lower it.
{
  const entry = { hooks: [{ type: "command", command: "oked-hook", timeout: 1200 }] };
  assert.equal(ensureHookTimeout(entry), false, "a longer user timeout should be left alone");
  assert.equal(entry.hooks[0].timeout, 1200);
  passed++;
}

// Other people's hooks in the same entry are not ours to touch.
{
  const entry = { hooks: [{ type: "command", command: "some-other-hook", timeout: 5 }] };
  assert.equal(ensureHookTimeout(entry), false, "foreign hooks should be ignored");
  assert.equal(entry.hooks[0].timeout, 5);
  passed++;
}

// The pre-existing MCP matcher upgrade still behaves.
{
  assert.equal(ensureMcpMatcher("Bash|Write"), "Bash|Write|mcp__.*", "should append the MCP matcher");
  assert.equal(ensureMcpMatcher("Bash|mcp__.*"), "Bash|mcp__.*", "should not double-append");
  passed++;
}

console.log(`ok - @oked/claude-code smoke: ${passed}/6 passed`);
