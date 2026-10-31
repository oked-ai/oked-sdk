#!/usr/bin/env node
import { existsSync } from "fs";
import { applyInstallMode, maskKey, pairDevice, printWatchReport, writeOkedConfig, type ClaudeHookHit } from "@oked/hook-core";
import { OKedClient, OKED_CONFIG_PATH } from "@oked/sdk";
import { copilotHookInstalled, hooksPath, installCopilotHook, uninstallCopilotHook } from "./install.js";
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
  await applyInstallMode();
  const cwd = process.cwd();
  const result = installCopilotHook(cwd, { native: NATIVE });
  if (result.action === "unreadable") {
    console.log(`OKed could not read ${result.path}. It was not changed.`);
  } else if (result.action === "skipped-claude-hook") {
    console.log("Copilot CLI and VS Code already run an @oked/claude-code hook from this project's Claude settings.");
    console.log("A native hook as well would ask twice, so .github/hooks/oked.json was not added.");
    printClaudeHits(result.claudeHooks);
    console.log("Copilot reads .claude/settings.json and .claude/settings.local.json in the repository. It does not read ~/.claude/settings.json.");
    console.log("To install the native hook anyway, run `oked-copilot init --native`. You will get two prompts until you remove the project oked-hook entry.");
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
    console.log("A project Claude Code oked-hook is also installed. Copilot runs both, so you will be asked twice.");
    printClaudeHits(result.claudeHooks);
    console.log("Remove the oked-hook entry from the project Claude settings to keep a single prompt.");
  }

  const existing = new OKedClient();
  if (existing.apiKey) {
    const ok = await existing.ping();
    console.log("");
    console.log(`  API key: ${maskKey(existing.apiKey)} (already paired)`);
    console.log(`  Backend: ${existing.backendUrl} (${ok ? "connected" : "not reachable"})`);
    console.log("");
    console.log("Copilot CLI and VS Code in this project now ask before a risky tool call.");
    return;
  }

  const apiKey = await pairDevice({
    backendUrl: BACKEND,
    clientType: "copilot",
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
  console.log("Copilot CLI and VS Code in this project now ask before a risky tool call.");
  console.log("Open a new session to load the hook.");
}

async function status(): Promise<void> {
  const path = hooksPath(process.cwd());
  const client = new OKedClient();
  console.log("OKed status:");
  console.log(`  Hook: ${copilotHookInstalled(process.cwd()) ? "installed" : "not installed"}`);
  console.log(`  Project config: ${existsSync(path) ? path : "not found"}`);
  console.log(`  API key: ${client.apiKey ? maskKey(client.apiKey) : "not paired"}`);
  console.log(`  Mode: ${client.mode}`);
  console.log(`  User config: ${existsSync(OKED_CONFIG_PATH) ? OKED_CONFIG_PATH : "not found"}`);
  if (client.apiKey) {
    const ok = await client.ping();
    console.log(`  Backend: ${client.backendUrl} (${ok ? "connected" : "not reachable"})`);
  }
}

function uninstall(): void {
  const result = uninstallCopilotHook(process.cwd());
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
  case "report":
    printWatchReport();
    break;
  default:
    console.log("Usage: oked-copilot <command>");
    console.log("");
    console.log("Commands:");
    console.log("  init        Install the Copilot preToolUse hook and pair this device");
    console.log("    --native      Install even when a project Claude Code oked-hook is present");
    console.log("    --no-browser  Print the pairing link. Open no browser, use no clipboard.");
    console.log("    --mode watch|enforce");
    console.log("                  watch records risky actions and lets them run. enforce pauses them.");
    console.log("  status      Show the hook and the connection");
    console.log("  report      Summarize actions watch mode would have paused");
    console.log("  uninstall   Remove the OKed Copilot hook from this project");
    break;
}
