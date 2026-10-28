#!/usr/bin/env node
import { existsSync } from "fs";
import { maskKey, pairDevice, writeOkedConfig } from "@oked/hook-core";
import { OKedClient, OKED_CONFIG_PATH } from "@oked/sdk";
import { codexHookInstalled, hooksPath, installCodexHook, uninstallCodexHook } from "./install.js";
import { CLIENT_VERSION, PAIR_COMMAND } from "./version.js";

const BACKEND = process.env.OKED_BACKEND_URL || "https://api.oked.ai";
const NO_BROWSER = process.argv.includes("--no-browser");

function footer(uri: string): [string, string] {
  return [`  (Or visit ${uri} and enter the code above.)`, "  The iPhone app is coming soon."];
}

async function init(): Promise<void> {
  const cwd = process.cwd();
  const result = installCodexHook(cwd);
  if (result.action === "unreadable") {
    console.log(`OKed could not read ${result.path}. It was not changed.`);
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
  console.log("  After this, run /hooks in Codex and trust the hook.");
  console.log("  Trust follows the hook hash. A changed timeout asks again.");

  const existing = new OKedClient();
  if (existing.apiKey) {
    const ok = await existing.ping();
    console.log("");
    console.log(`  API key: ${maskKey(existing.apiKey)} (already paired)`);
    console.log(`  Backend: ${existing.backendUrl} (${ok ? "connected" : "not reachable"})`);
    console.log("");
    console.log("Codex in this project now asks before a risky tool call.");
    return;
  }

  const apiKey = await pairDevice({
    backendUrl: BACKEND,
    clientType: "codex",
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
  console.log("Codex in this project now asks before a risky tool call.");
  console.log("Open a new Codex session, then trust the hook with /hooks.");
}

async function status(): Promise<void> {
  const path = hooksPath(process.cwd());
  const client = new OKedClient();
  console.log("OKed status:");
  console.log(`  Hook: ${codexHookInstalled(process.cwd()) ? "installed" : "not installed"}`);
  console.log(`  Project config: ${existsSync(path) ? path : "not found"}`);
  console.log(`  API key: ${client.apiKey ? maskKey(client.apiKey) : "not paired"}`);
  console.log(`  User config: ${existsSync(OKED_CONFIG_PATH) ? OKED_CONFIG_PATH : "not found"}`);
  if (client.apiKey) {
    const ok = await client.ping();
    console.log(`  Backend: ${client.backendUrl} (${ok ? "connected" : "not reachable"})`);
  }
}

function uninstall(): void {
  const result = uninstallCodexHook(process.cwd());
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
    console.log("Usage: oked-codex <command>");
    console.log("");
    console.log("Commands:");
    console.log("  init        Install the Codex PreToolUse hook and pair this device");
    console.log("    --no-browser  Print the pairing link. Open no browser, use no clipboard.");
    console.log("  status      Show the hook and the connection");
    console.log("  uninstall   Remove the OKed hook from this project");
    break;
}
