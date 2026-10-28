#!/usr/bin/env node
import { existsSync } from "fs";
import { maskKey, pairDevice, writeOkedConfig, type ClaudeHookHit } from "@oked/hook-core";
import { OKedClient, OKED_CONFIG_PATH } from "@oked/sdk";
import { cursorHookInstalled, hooksPath, installCursorHook, uninstallCursorHook } from "./install.js";
import { CLIENT_VERSION, PAIR_COMMAND } from "./version.js";

const BACKEND = process.env.OKED_BACKEND_URL || "https://api.oked.ai";
const NO_BROWSER = process.argv.includes("--no-browser");
const NATIVE = process.argv.includes("--native");

function footer(uri: string): [string, string] {
  return [`  (Or visit ${uri} and enter the code above.)`, "  The iPhone app is coming soon."];
}

function printClaudeHits(hits: ClaudeHookHit[]): void {
  for (const hit of hits) console.log(`  ${hit.scope}: ${hit.path}`);
}

async function init(): Promise<void> {
  const cwd = process.cwd();
  const result = installCursorHook(cwd, { native: NATIVE });
  if (result.action === "unreadable") {
    console.log(`OKed could not read ${result.path}. It was not changed.`);
  } else if (result.action === "skipped-claude-hook") {
    console.log("Cursor already runs an @oked/claude-code hook from Claude settings.");
    console.log("A native hook as well would ask twice, so .cursor/hooks.json was not added.");
    printClaudeHits(result.claudeHooks);
    console.log("That imported hook returns ask when this device is not paired, and Cursor does not enforce ask on preToolUse.");
    console.log("It also has no failClosed field. Cursor defaults that to false, so a killed hook fails open.");
    console.log("To install the native hook, turn off Settings > Agents > Third-Party Imports, or remove that oked-hook entry, then run `oked-cursor init --native`.");
    console.log("This command does not remove the Claude Code hook.");
  } else if (result.action === "installed") {
    console.log("OKed hook installed.");
    console.log(`  Config: ${result.path}`);
  } else if (result.action === "updated") {
    console.log("OKed hook updated.");
    console.log(`  Config: ${result.path}`);
  } else {
    console.log("OKed hook already configured.");
    console.log(`  Config: ${result.path}`);
  }
  if (result.claudeHooks.length > 0 && result.action !== "skipped-claude-hook" && result.action !== "unreadable") {
    console.log("A Claude Code oked-hook is also installed. Cursor runs every matching hook, so you will be asked twice.");
    printClaudeHits(result.claudeHooks);
    console.log("Turn off Settings > Agents > Third-Party Imports, or remove the oked-hook entry, to keep a single prompt.");
  }

  const existing = new OKedClient();
  if (existing.apiKey) {
    const ok = await existing.ping();
    console.log("");
    console.log(`  API key: ${maskKey(existing.apiKey)} (already paired)`);
    console.log(`  Backend: ${existing.backendUrl} (${ok ? "connected" : "not reachable"})`);
    console.log("");
    console.log("Cursor in this project now asks before a risky tool call.");
    return;
  }

  const apiKey = await pairDevice({
    backendUrl: BACKEND,
    clientType: "cursor",
    clientVersion: CLIENT_VERSION,
    noBrowser: NO_BROWSER,
    retryCommand: PAIR_COMMAND,
    scanLine: "  Or scan this with your phone camera. It opens the pairing page in the browser.",
    footerLines: footer,
  });
  if (!apiKey) return;
  writeOkedConfig(apiKey, BACKEND);
  console.log("");
  console.log(`  Paired. Key saved to ${OKED_CONFIG_PATH}`);
  console.log("");
  console.log("Cursor in this project now asks before a risky tool call.");
  console.log("Open a new Cursor agent session to load the hook.");
}

async function status(): Promise<void> {
  const path = hooksPath(process.cwd());
  const client = new OKedClient();
  console.log("OKed status:");
  console.log(`  Hook: ${cursorHookInstalled(process.cwd()) ? "installed" : "not installed"}`);
  console.log(`  Project config: ${existsSync(path) ? path : "not found"}`);
  console.log(`  API key: ${client.apiKey ? maskKey(client.apiKey) : "not paired"}`);
  console.log(`  User config: ${existsSync(OKED_CONFIG_PATH) ? OKED_CONFIG_PATH : "not found"}`);
  if (client.apiKey) {
    const ok = await client.ping();
    console.log(`  Backend: ${client.backendUrl} (${ok ? "connected" : "not reachable"})`);
  }
}

function uninstall(): void {
  const result = uninstallCursorHook(process.cwd());
  if (result.action === "unreadable") {
    console.log(`OKed could not read ${result.path}. It was not changed.`);
    return;
  }
  if (result.action === "absent") {
    console.log("OKed hook was not installed in this project.");
    return;
  }
  console.log("OKed hook removed from this project.");
  console.log(`  Config: ${result.path}`);
  console.log("A Claude Code hook, if you have one, was left in place.");
}

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
  default:
    console.log("Usage: oked-cursor <command>");
    console.log("");
    console.log("Commands:");
    console.log("  init        Install the Cursor preToolUse hook and pair this device");
    console.log("    --native      Install even when a Claude Code oked-hook is already present");
    console.log("    --no-browser  Print the pairing link. Open no browser, use no clipboard.");
    console.log("  status      Show the hook and the connection");
    console.log("  uninstall   Remove the OKed Cursor hook from this project");
    break;
}
