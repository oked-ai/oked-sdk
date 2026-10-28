import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";
import {
  codexHookInstalled,
  installCodexHook,
  removeCodexHooks,
  uninstallCodexHook,
  upsertCodexHooks,
} from "../dist/install.js";

let passed = 0;
const root = mkdtempSync(join(tmpdir(), "oked-codex-install-"));

try {
  const first = upsertCodexHooks({});
  assert.equal(first.changed, true);
  const hook = first.doc.hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.command, "oked-codex-hook");
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
  assert.equal(hook.timeout, 690);
  assert.equal(hook.async, undefined);
  assert.equal(first.doc.hooks.PreToolUse[0].matcher, "*");
  const again = upsertCodexHooks(first.doc);
  assert.equal(again.changed, false);
  passed++;

  const stale = upsertCodexHooks({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "oked-codex-hook", timeout: 30, async: true }] }],
      Stop: [{ hooks: [{ type: "command", command: "other" }] }],
    },
  });
  assert.equal(stale.changed, true);
  assert.equal(stale.doc.hooks.PreToolUse[0].hooks[0].timeout, 690);
  assert.equal(stale.doc.hooks.PreToolUse[0].hooks[0].async, undefined);
  assert.equal(stale.doc.hooks.Stop[0].hooks[0].command, "other");
  const longer = upsertCodexHooks({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "oked-codex-hook", timeout: 1200 }] }] },
  });
  assert.equal(longer.changed, false);
  assert.equal(longer.doc.hooks.PreToolUse[0].hooks[0].timeout, 1200);
  passed++;

  const removed = removeCodexHooks(stale.doc);
  assert.equal(removed.changed, true);
  assert.equal(removed.doc.hooks.PreToolUse, undefined);
  assert.equal(removed.doc.hooks.Stop[0].hooks[0].command, "other");
  assert.equal(removeCodexHooks(removed.doc).changed, false);
  passed++;

  const project = join(root, "proj");
  mkdirSync(project);
  const installed = installCodexHook(project);
  assert.equal(installed.action, "installed");
  assert.equal(codexHookInstalled(project), true);
  const raw = JSON.parse(readFileSync(installed.path, "utf8"));
  assert.equal(raw.hooks.PreToolUse.length, 1);
  assert.equal(installCodexHook(project).action, "unchanged");
  assert.equal(JSON.parse(readFileSync(installed.path, "utf8")).hooks.PreToolUse.length, 1);
  writeFileSync(installed.path, "{");
  assert.equal(installCodexHook(project).action, "unreadable");
  assert.equal(readFileSync(installed.path, "utf8"), "{");
  writeFileSync(
    installed.path,
    JSON.stringify({
      description: "keep",
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "oked-codex-hook", timeout: 10 }] },
          { hooks: [{ type: "command", command: "audit" }] },
        ],
      },
    }),
  );
  assert.equal(installCodexHook(project).action, "updated");
  const updated = JSON.parse(readFileSync(installed.path, "utf8"));
  assert.equal(updated.description, "keep");
  assert.equal(updated.hooks.PreToolUse[0].hooks[0].timeout, 690);
  assert.equal(updated.hooks.PreToolUse[1].hooks[0].command, "audit");
  assert.equal(uninstallCodexHook(project).action, "removed");
  const after = JSON.parse(readFileSync(installed.path, "utf8"));
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "audit");
  assert.equal(uninstallCodexHook(project).action, "absent");
  assert.equal(existsSync(installed.path), true);
  passed++;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`ok - @oked/codex install: ${passed}/4 passed`);
