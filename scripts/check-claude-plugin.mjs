#!/usr/bin/env node
// Fail when the committed Claude Code plugin bundle, version, or manifest
// does not match the source. Also runs the plugin hook tests.

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins", "claude-code");
const BUNDLE = join(PLUGIN, "scripts", "oked-hook.mjs");
const MAX_BYTES = 256 * 1024;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pkgVersion = readJson(join(ROOT, "packages", "claude-code", "package.json")).version;
const plugin = readJson(join(PLUGIN, ".claude-plugin", "plugin.json"));
if (plugin.version !== pkgVersion) {
  fail(`plugin.json version ${plugin.version} != @oked/claude-code ${pkgVersion}`);
}
if (plugin.name !== "oked" || plugin.displayName !== "OKed" || plugin.license !== "Apache-2.0") {
  fail("plugin.json name, displayName, or license is wrong");
}
if (plugin.author?.name !== "OKed" || plugin.author?.email !== "contact@oked.ai") {
  fail("plugin.json author must be OKed <contact@oked.ai>");
}
if (plugin.userConfig?.apiKey?.sensitive !== true) {
  fail("plugin.json userConfig.apiKey must be sensitive");
}

const hooks = readJson(join(PLUGIN, "hooks", "hooks.json"));
const entry = hooks.hooks?.PreToolUse?.[0];
const hook = entry?.hooks?.[0];
if (entry?.matcher !== "Bash|Write|Edit|Agent|mcp__.*") fail("hooks.json matcher is wrong");
if (hook?.timeout !== 690) fail("hooks.json timeout must be 690");
if (hook?.command !== 'node "${CLAUDE_PLUGIN_ROOT}/scripts/oked-hook.mjs"') {
  fail(`hooks.json command is wrong: ${hook?.command}`);
}

const marketplace = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
if (marketplace.name !== "oked") fail("marketplace name must be oked");
if (marketplace.plugins?.[0]?.name !== "oked") fail("marketplace plugin name must be oked");
if (marketplace.plugins?.[0]?.source !== "./plugins/claude-code") fail("marketplace source is wrong");
if (marketplace.owner?.email !== "contact@oked.ai") fail("marketplace owner email must be contact@oked.ai");

const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
const prose = readme
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/`[^`]*`/g, " ");
const words = prose.split(/\s+/).filter(Boolean);
if (words.length < 40) fail(`plugin README has ${words.length} words outside code, need at least 40`);
if (!/tool name/i.test(readme) || !/command text|tool input/i.test(readme) || !/api\.oked\.ai/.test(readme)) {
  fail("plugin README must say that tool and command text is sent to the OKed service");
}

const banned = ["OKED_BACKEND_URL", "backendUrl", "\u2014"];
const publicFiles = [
  join(PLUGIN, "README.md"),
  join(PLUGIN, "skills", "pair", "SKILL.md"),
  join(PLUGIN, ".claude-plugin", "plugin.json"),
  join(PLUGIN, "hooks", "hooks.json"),
  join(ROOT, ".claude-plugin", "marketplace.json"),
];
for (const path of publicFiles) {
  const text = readFileSync(path, "utf8");
  for (const token of banned) {
    if (text.includes(token)) fail(`${path} contains ${token}`);
  }
}

const committed = readFileSync(BUNDLE);
if (committed.length > MAX_BYTES) fail(`bundle is ${committed.length} bytes, limit is ${MAX_BYTES}`);
if (!committed.includes(`oked-plugin@${pkgVersion}`)) {
  fail(`bundle is missing oked-plugin@${pkgVersion}. Run node scripts/build-claude-plugin.mjs`);
}

const tmp = mkdtempSync(join(tmpdir(), "oked-plugin-bundle-"));
const fresh = join(tmp, "oked-hook.mjs");
try {
  const built = spawnSync(process.execPath, [join(ROOT, "scripts", "build-claude-plugin.mjs"), fresh], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (built.status !== 0) fail(built.stderr || built.stdout || "bundle build failed");
  const next = readFileSync(fresh);
  if (!committed.equals(next)) {
    fail("plugins/claude-code/scripts/oked-hook.mjs is stale. Run node scripts/build-claude-plugin.mjs");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const tests = spawnSync(process.execPath, [join(ROOT, "scripts", "claude-plugin.test.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
if (tests.status !== 0) {
  process.stderr.write(tests.stdout || "");
  process.stderr.write(tests.stderr || "");
  fail("plugin tests failed");
}
process.stdout.write(tests.stdout || "");
console.log("ok - claude code plugin bundle is current");
