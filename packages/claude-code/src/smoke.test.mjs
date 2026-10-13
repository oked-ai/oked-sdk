// Offline smoke test — no network, no API key. Covers the settings.json hook
// entry: the timeout nesting invariant, and the in-place upgrades `oked init`
// applies to an existing entry. Run via `npm test` (builds first, then
// executes against dist/).
import assert from "node:assert";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "@oked/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_CONFIG,
  HOOK_TIMEOUT_SECONDS,
  ensureHookTimeout,
  ensureMcpMatcher,
  hasOkedCommandHook,
  upgradeOkedHooks,
  upgradeSettingsFile,
  userSettingsPath,
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

// User-level settings: an existing oked-hook entry gets the new timeout and
// matcher; other hooks and other settings stay as they are.
{
  const dir = mkdtempSync(join(tmpdir(), "oked-settings-"));
  try {
    const path = join(dir, "settings.json");
    const before = {
      model: "opus",
      hooks: {
        PreToolUse: [
          { matcher: "Bash|Write|Edit|Agent", hooks: [{ type: "command", command: "oked-hook", timeout: 300 }] },
          { matcher: "*", hooks: [{ type: "command", command: "node audit.mjs", timeout: 10 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "node audit.mjs", timeout: 10 }] }],
      },
    };
    writeFileSync(path, JSON.stringify(before, null, 2));
    assert.equal(upgradeSettingsFile(path), "updated");
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.hooks.PreToolUse[0].hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
    assert.equal(after.hooks.PreToolUse[0].matcher, "Bash|Write|Edit|Agent|mcp__.*");
    assert.deepEqual(after.hooks.PreToolUse[1], before.hooks.PreToolUse[1], "a foreign hook stays");
    assert.deepEqual(after.hooks.Stop, before.hooks.Stop, "other events stay");
    assert.equal(after.model, "opus", "other settings stay");
    assert.equal(upgradeSettingsFile(path), "unchanged", "a second run changes nothing");
    passed++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// It never installs the hook in a user file that does not have it, and it never
// rewrites a file it cannot read.
{
  const dir = mkdtempSync(join(tmpdir(), "oked-settings-"));
  try {
    const none = join(dir, "none.json");
    writeFileSync(none, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "other" }] }] } }));
    assert.equal(upgradeSettingsFile(none), "no-oked-hook");
    assert.ok(!readFileSync(none, "utf8").includes("oked-hook"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.equal(upgradeSettingsFile(bad), "unreadable");
    assert.equal(readFileSync(bad, "utf8"), "{ not json");
    assert.equal(upgradeSettingsFile(join(dir, "missing.json")), "absent");
    assert.equal(upgradeOkedHooks({}), false);
    passed++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// CLAUDE_CONFIG_DIR moves the user settings file, as in Claude Code.
{
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config-test";
  assert.equal(userSettingsPath(), "/tmp/claude-config-test/settings.json");
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  assert.ok(userSettingsPath().endsWith(join(".claude", "settings.json")) || process.env.CLAUDE_CONFIG_DIR);
  passed++;
}

console.log(`ok - @oked/claude-code smoke: ${passed}/9 passed`);
