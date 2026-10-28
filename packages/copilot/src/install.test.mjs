import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";
import {
  copilotHookInstalled,
  installCopilotHook,
  removeCopilotHooks,
  uninstallCopilotHook,
  upsertCopilotHooks,
} from "../dist/install.js";

let passed = 0;
const root = mkdtempSync(join(tmpdir(), "oked-copilot-install-"));
const prevClaude = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-user");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

try {
  const first = upsertCopilotHooks({});
  assert.equal(first.changed, true);
  assert.deepEqual(first.doc, {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", command: "oked-copilot-hook", timeoutSec: 690 }],
    },
  });
  assert.equal(first.doc.hooks.preToolUse[0].timeoutSec, HOOK_TIMEOUT_SECONDS);
  assert.equal(upsertCopilotHooks(first.doc).changed, false);
  passed++;

  const stale = upsertCopilotHooks({
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", bash: "oked-copilot-hook", timeout: 30 }],
      sessionStart: [{ type: "command", command: "banner" }],
    },
  });
  assert.equal(stale.changed, true);
  assert.equal(stale.doc.hooks.preToolUse[0].timeoutSec, 690);
  assert.equal(stale.doc.hooks.preToolUse[0].timeout, undefined);
  assert.equal(stale.doc.hooks.preToolUse[0].bash, "oked-copilot-hook");
  assert.equal(stale.doc.hooks.sessionStart[0].command, "banner");
  const longer = upsertCopilotHooks({
    version: 1,
    hooks: { preToolUse: [{ type: "command", command: "oked-copilot-hook", timeoutSec: 1200 }] },
  });
  assert.equal(longer.changed, false);
  assert.equal(longer.doc.hooks.preToolUse[0].timeoutSec, 1200);
  const alias = upsertCopilotHooks({
    version: 1,
    hooks: { preToolUse: [{ type: "command", command: "oked-copilot-hook", timeout: 1200 }] },
  });
  assert.equal(alias.changed, true);
  assert.equal(alias.doc.hooks.preToolUse[0].timeoutSec, 1200);
  assert.equal(alias.doc.hooks.preToolUse[0].timeout, undefined);
  passed++;

  const removed = removeCopilotHooks({
    version: 1,
    hooks: { preToolUse: [{ command: "oked-copilot-hook" }, { command: "audit" }] },
  });
  assert.equal(removed.changed, true);
  assert.equal(removed.doc.hooks.preToolUse.length, 1);
  assert.equal(removed.doc.hooks.preToolUse[0].command, "audit");
  assert.equal(removeCopilotHooks(removed.doc).changed, false);
  passed++;

  const project = join(root, "proj");
  mkdirSync(project);
  writeFileSync(
    join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "oked-hook" }] }] } }),
  );
  const userOnly = installCopilotHook(project);
  assert.equal(userOnly.action, "installed", "a user-level Claude hook does not gate Copilot");
  assert.equal(userOnly.claudeHooks.length, 0);
  const rawText = readFileSync(userOnly.path, "utf8");
  assert.deepEqual(JSON.parse(rawText), {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", command: "oked-copilot-hook", timeoutSec: 690 }],
    },
  });
  assert.equal(installCopilotHook(project).action, "unchanged");
  assert.equal(readFileSync(userOnly.path, "utf8"), rawText, "a second init does not rewrite an up-to-date file");
  writeFileSync(userOnly.path, "{");
  assert.equal(installCopilotHook(project).action, "unreadable");
  assert.equal(readFileSync(userOnly.path, "utf8"), "{");
  writeFileSync(
    userOnly.path,
    JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [
          { type: "command", command: "oked-copilot-hook", timeoutSec: 10 },
          { type: "command", command: "audit" },
        ],
      },
    }),
  );
  assert.equal(installCopilotHook(project).action, "updated");
  assert.equal(uninstallCopilotHook(project).action, "removed");
  const after = JSON.parse(readFileSync(userOnly.path, "utf8"));
  assert.equal(after.hooks.preToolUse.length, 1);
  assert.equal(after.hooks.preToolUse[0].command, "audit");
  assert.equal(uninstallCopilotHook(project).action, "absent");
  passed++;

  const gated = join(root, "gated");
  mkdirSync(join(gated, ".claude"), { recursive: true });
  writeFileSync(
    join(gated, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "oked-hook", timeout: 690 }] }] } }),
  );
  const skipped = installCopilotHook(gated);
  assert.equal(skipped.action, "skipped-claude-hook");
  assert.equal(existsSync(join(gated, ".github", "hooks", "oked.json")), false);
  assert.equal(skipped.claudeHooks[0].scope, "project");
  const forced = installCopilotHook(gated, { native: true });
  assert.equal(forced.action, "installed");
  assert.equal(copilotHookInstalled(gated), true);
  assert.equal(installCopilotHook(gated).action, "unchanged");
  assert.ok(existsSync(join(gated, ".claude", "settings.json")));
  passed++;
} finally {
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(root, { recursive: true, force: true });
}

console.log(`ok - @oked/copilot install: ${passed}/5 passed`);
