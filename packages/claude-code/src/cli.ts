#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { OKedClient, OKED_CONFIG_PATH } from "@oked/sdk";
import {
  claudeSandboxEnforced,
  maskKey,
  OKED_RECEIPTS_LOG,
  pairDevice,
  SANDBOX_INIT_HINT,
  verifyReceiptsFile,
  writeOkedConfig,
} from "@oked/hook-core";
import {
  HOOK_CONFIG,
  hasOkedCommandHook,
  ensureMcpMatcher,
  ensureHookTimeout,
  upgradeSettingsFile,
  userSettingsPath,
} from "./hook-config.js";

import { CLIENT_VERSION } from "./version.js";

const DEFAULT_BACKEND_URL =
  process.env.OKED_BACKEND_URL || "https://api.oked.ai";

/** `oked init --key-only`: create or show the API key; add or change no hook. */
const KEY_ONLY = process.argv.includes("--key-only");
/** `oked init --no-browser`: print the pairing link; open no browser, use no clipboard. */
const NO_BROWSER = process.argv.includes("--no-browser");

function getSettingsPath(): string {
  return join(process.cwd(), ".claude", "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(
  path: string,
  settings: Record<string, unknown>
): void {
  const dir = join(process.cwd(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

/** Suggest the Bash sandbox when it is not already containing child processes. */
function printSandboxHint(): void {
  if (claudeSandboxEnforced(process.cwd())) return;
  console.log("");
  for (const line of SANDBOX_INIT_HINT.split("\n")) console.log(`  ${line}`);
}

/**
 * `oked init --key-only`: pair this device (or show the existing key) and save
 * the key in ~/.oked/config.json. It adds no Claude Code hook and changes no
 * settings file. For tools that only need the key, such as the OpenShell
 * middleware.
 */
async function initKeyOnly(): Promise<void> {
  const existing = new OKedClient();
  if (existing.apiKey) {
    const ok = await existing.ping();
    const where = process.env.OKED_API_KEY ? "the OKED_API_KEY environment variable" : OKED_CONFIG_PATH;
    console.log("OKed API key already set up (no hook added).");
    console.log("");
    console.log(`  API key: ${maskKey(existing.apiKey)}`);
    console.log(`  Stored in: ${where}`);
    console.log(`  Backend: ${existing.backendUrl} (${ok ? "connected" : "not reachable"})`);
    return;
  }

  const apiKey = await pairDevice({
    backendUrl: DEFAULT_BACKEND_URL,
    clientType: "sdk",
    clientVersion: CLIENT_VERSION,
    noBrowser: NO_BROWSER,
  });
  if (!apiKey) return;

  writeOkedConfig(apiKey, DEFAULT_BACKEND_URL);
  console.log("");
  console.log(`  Paired ✓  API key ${maskKey(apiKey)} saved to ${OKED_CONFIG_PATH}`);
  console.log("  No Claude Code hook was added. Run `oked init` without --key-only to add it.");
}

async function init(): Promise<void> {
  if (KEY_ONLY) return initKeyOnly();
  const settingsPath = getSettingsPath();
  const settings = readSettings(settingsPath);

  // Merge OKed hook into existing hooks
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse || []) as Array<{
    matcher?: string;
    hooks?: unknown[];
  }>;

  // Check if OKed hook already exists and upgrade it in place: older matchers
  // need to cover MCP tools (`mcp__<server>__<tool>`) as regular PreToolUse
  // events, and older timeouts predate the 10-minute approval window.
  let updatedOkedHook = false;
  const hasOked = preToolUse.some((entry) => {
    if (!hasOkedCommandHook(entry)) return false;
    const nextMatcher = ensureMcpMatcher(entry.matcher);
    if (nextMatcher !== entry.matcher) {
      entry.matcher = nextMatcher;
      updatedOkedHook = true;
    }
    if (ensureHookTimeout(entry)) updatedOkedHook = true;
    return true;
  });

  if (!hasOked) {
    preToolUse.push(HOOK_CONFIG);
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
    console.log("OKed hook installed.");
    console.log(`  Config: ${settingsPath}`);
  } else if (updatedOkedHook) {
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
    console.log("OKed hook updated.");
    console.log(`  Config: ${settingsPath}`);
  } else {
    console.log("OKed hook already configured.");
    console.log(`  Config: ${settingsPath}`);
  }

  // An oked-hook entry in the user-level settings (all projects) gets the
  // same upgrades, so existing users get a new timeout when they run init
  // after an update. Init never adds the hook there.
  const userPath = userSettingsPath();
  if (userPath !== settingsPath) {
    const result = upgradeSettingsFile(userPath);
    if (result === "updated") {
      console.log("OKed hook updated in your user settings (all projects).");
      console.log(`  Config: ${userPath}`);
    } else if (result === "unreadable") {
      console.log(`  Note: could not read ${userPath}; it was not changed.`);
    }
  }

  // Already paired? Just ping and exit.
  const existingClient = new OKedClient();
  if (existingClient.apiKey) {
    const ok = await existingClient.ping();
    console.log("");
    console.log(`  API key: ${maskKey(existingClient.apiKey)} (already paired)`);
    console.log(`  Backend: ${existingClient.backendUrl} (${ok ? "connected" : "not reachable"})`);
    console.log("");
    console.log("Every Claude Code session in this project is now protected.");
    printSandboxHint();
    return;
  }

  // Pair this device.
  const apiKey = await pairDevice({
    backendUrl: DEFAULT_BACKEND_URL,
    clientType: "claude-code",
    clientVersion: CLIENT_VERSION,
    noBrowser: NO_BROWSER,
  });
  if (!apiKey) {
    printSandboxHint();
    return;
  }

  writeOkedConfig(apiKey, DEFAULT_BACKEND_URL);
  console.log("");
  console.log(`  Paired ✓  Key saved to ${OKED_CONFIG_PATH}`);
  console.log("");
  console.log("Every Claude Code session in this project is now protected.");
  console.log("Open a new Claude Code session to activate the hook.");
  printSandboxHint();
}

async function status(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = readSettings(settingsPath);

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse || []) as Array<{
    matcher?: string;
    hooks?: unknown[];
  }>;
  const hasOked = preToolUse.some(hasOkedCommandHook);

  const client = new OKedClient();
  console.log(`OKed status:`);
  console.log(`  Hook: ${hasOked ? "installed" : "not installed"}`);
  console.log(`  Project config: ${existsSync(settingsPath) ? settingsPath : "not found"}`);
  console.log(`  API key: ${client.apiKey ? client.apiKey.slice(0, 8) + "..." : "not paired"}`);
  console.log(`  User config: ${existsSync(OKED_CONFIG_PATH) ? OKED_CONFIG_PATH : "not found"}`);

  if (client.apiKey) {
    const ok = await client.ping();
    console.log(`  Backend: ${client.backendUrl} (${ok ? "connected" : "not reachable"})`);
  }
}

function uninstall(): void {
  const settingsPath = getSettingsPath();
  const settings = readSettings(settingsPath);

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse || []) as Array<{
    matcher?: string;
    hooks?: unknown[];
  }>;

  // Remove OKed hook entries
  hooks.PreToolUse = preToolUse.filter(
    (entry) => !hasOkedCommandHook(entry)
  );

  if ((hooks.PreToolUse as unknown[]).length === 0) {
    delete hooks.PreToolUse;
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settingsPath, settings);
  console.log("OKed hooks removed from this project.");
}

async function receipts(): Promise<void> {
  if (process.argv[3] !== "verify") {
    console.log("Usage: oked receipts verify [file]");
    console.log(`  file defaults to ${OKED_RECEIPTS_LOG}`);
    return;
  }
  const file = process.argv[4] || OKED_RECEIPTS_LOG;
  const report = await verifyReceiptsFile(file);
  console.log(`${file}: ${report.total} receipt(s), ${report.valid} valid`);
  for (const bad of report.invalid) {
    console.log(`  line ${bad.line} ${bad.receipt_id ?? "(no id)"}: ${bad.problems.join(", ")}`);
  }
  for (const line of report.unparsable) console.log(`  line ${line}: not valid JSON`);
  for (const chain of report.chains) {
    const gaps = chain.gaps.length
      ? `, ${chain.gaps.length} gap(s) (expected when other devices share this chain)`
      : "";
    console.log(`  chain ${chain.chain_id}: seq ${chain.first_seq}..${chain.last_seq}${gaps}`);
    for (const b of chain.breaks) console.log(`    BROKEN at seq ${b.seq}: ${b.reason}`);
  }
  const ok = report.invalid.length === 0 && report.unparsable.length === 0 && report.chains.every((c) => c.breaks.length === 0);
  console.log(ok ? "OK" : "PROBLEMS FOUND");
  if (!ok) process.exitCode = 1;
}

// CLI entry point
const command = process.argv[2];

switch (command) {
  case "init":
    init().catch(console.error);
    break;
  case "status":
    status().catch(console.error);
    break;
  case "uninstall":
    uninstall();
    break;
  case "receipts":
    receipts().catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
    break;
  default:
    console.log("Usage: oked <command>");
    console.log("");
    console.log("Commands:");
    console.log("  init        Install OKed hooks in current project and pair this device");
    console.log("    --key-only    Only create or show the API key. Add no hook.");
    console.log("    --no-browser  Print the pairing link. Open no browser, use no clipboard.");
    console.log("  status      Show current config and connection status");
    console.log("  uninstall   Remove OKed hooks from current project");
    console.log("  receipts verify [file]  Check this machine's approval receipts");
    break;
}
