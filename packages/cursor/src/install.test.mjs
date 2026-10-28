import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";
import {
  cursorHookInstalled,
  installCursorHook,
  removeCursorHooks,
  uninstallCursorHook,
  upsertCursorHooks,
} from "../dist/install.js";

let passed = 0;
const root = mkdtempSync(join(tmpdir(), "oked-cursor-install-"));
const prevClaude = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-user");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

try {
  const first = upsertCursorHooks({});
  assert.equal(first.changed, true);
  assert.equal(first.doc.version, 1);
  const hook = first.doc.hooks.preToolUse[0];
  assert.equal(hook.command, "oked-cursor-hook");
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
  assert.equal(hook.timeout, 690);
  assert.equal(hook.failClosed, true);
  assert.equal(upsertCursorHooks(first.doc).changed, false);
  passed++;

  const stale = upsertCursorHooks({
    version: 1,
    hooks: {
      preToolUse: [{ command: "oked-cursor-hook", timeout: 30 }],
      stop: [{ command: "audit" }],
    },
  });
  assert.equal(stale.changed, true);
  assert.equal(stale.doc.hooks.preToolUse[0].timeout, 690);
  assert.equal(stale.doc.hooks.preToolUse[0].failClosed, true);
  assert.equal(stale.doc.hooks.stop[0].command, "audit");
  const longer = upsertCursorHooks({
    version: 1,
    hooks: { preToolUse: [{ command: "oked-cursor-hook", timeout: 1200, failClosed: true }] },
  });
  assert.equal(longer.changed, false);
  assert.equal(longer.doc.hooks.preToolUse[0].timeout, 1200);
  passed++;

  const removed = removeCursorHooks({
    version: 1,
    hooks: {
      preToolUse: [{ command: "oked-cursor-hook" }, { command: "audit" }],
    },
  });
  assert.equal(removed.changed, true);
  assert.equal(removed.doc.hooks.preToolUse.length, 1);
  assert.equal(removed.doc.hooks.preToolUse[0].command, "audit");
  assert.equal(removeCursorHooks(removed.doc).changed, false);
  passed++;

  const project = join(root, "proj");
  mkdirSync(project);
  const installed = installCursorHook(project);
  assert.equal(installed.action, "installed");
  assert.equal(cursorHookInstalled(project), true);
  const raw = JSON.parse(readFileSync(installed.path, "utf8"));
  assert.equal(raw.hooks.preToolUse[0].timeout, 690);
  assert.equal(raw.hooks.preToolUse[0].failClosed, true);
  assert.equal(installCursorHook(project).action, "unchanged");
  writeFileSync(installed.path, "{");
  assert.equal(installCursorHook(project).action, "unreadable");
  assert.equal(readFileSync(installed.path, "utf8"), "{");
  writeFileSync(
    installed.path,
    JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ command: "oked-cursor-hook", timeout: 10 }, { command: "audit" }] },
    }),
  );
  assert.equal(installCursorHook(project).action, "updated");
  assert.equal(uninstallCursorHook(project).action, "removed");
  const after = JSON.parse(readFileSync(installed.path, "utf8"));
  assert.equal(after.hooks.preToolUse.length, 1);
  assert.equal(after.hooks.preToolUse[0].command, "audit");
  assert.equal(uninstallCursorHook(project).action, "absent");
  passed++;

  const gated = join(root, "gated");
  mkdirSync(join(gated, ".claude"), { recursive: true });
  writeFileSync(
    join(gated, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "oked-hook", timeout: 690 }] }] } }),
  );
  const skipped = installCursorHook(gated);
  assert.equal(skipped.action, "skipped-claude-hook");
  assert.equal(existsSync(join(gated, ".cursor", "hooks.json")), false);
  assert.equal(skipped.claudeHooks[0].scope, "project");
  const forced = installCursorHook(gated, { native: true });
  assert.equal(forced.action, "installed");
  assert.equal(cursorHookInstalled(gated), true);
  assert.equal(installCursorHook(gated).action, "unchanged", "a later init keeps the native hook");
  assert.ok(existsSync(join(gated, ".claude", "settings.json")));
  passed++;
} finally {
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(root, { recursive: true, force: true });
}

console.log(`ok - @oked/cursor install: ${passed}/5 passed`);
