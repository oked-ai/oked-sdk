#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { homedir, hostname } from "os";
import { join, dirname } from "path";
import { spawn } from "child_process";
import {
  OKedClient,
  loadOKedConfig,
  OKED_CONFIG_PATH,
  SDK_VERSION,
  runUpdate,
  rollback,
  getRunningVersion,
  readUpdateState,
  writeUpdateState,
} from "@oked/sdk";

const HOOK_CONFIG = {
  matcher: "Bash|Write|Edit|Agent",
  hooks: [
    {
      type: "command",
      command: "oked-hook",
      timeout: 300,
    },
  ],
};

const DEFAULT_BACKEND_URL =
  process.env.OKED_BACKEND_URL || "https://api.oked.ai";
const CLIENT_VERSION = getRunningVersion();

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

function writeOkedConfig(apiKey: string, backendUrl: string): void {
  const dir = dirname(OKED_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = loadOKedConfig();
  const payload = { ...existing, apiKey, backendUrl };
  writeFileSync(OKED_CONFIG_PATH, JSON.stringify(payload, null, 2) + "\n");
  try {
    chmodSync(OKED_CONFIG_PATH, 0o600);
  } catch {
    // Windows doesn't honor chmod; the file lives in the user profile anyway.
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best effort. The user has the URL on screen anyway.
  }
}

async function pair(clientType: "claude-code" | "openclaw" | "sdk"): Promise<string | null> {
  const codeRes = await fetch(`${DEFAULT_BACKEND_URL}/api/v1/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_type: clientType,
      hostname: hostname(),
      client_version: CLIENT_VERSION,
    }),
  });
  if (!codeRes.ok) {
    console.log(`  Failed to start pairing: ${codeRes.status} ${await codeRes.text()}`);
    return null;
  }
  const code = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };

  console.log("");
  console.log("  To pair this device, open:");
  console.log(`    ${code.verification_uri_complete}`);
  console.log("");
  console.log("  Or visit " + code.verification_uri + " and enter the code:");
  console.log(`    ${code.user_code}`);
  console.log("");
  console.log("  Waiting for confirmation in your browser...");

  openBrowser(code.verification_uri_complete);

  const deadline = Date.now() + code.expires_in * 1000;
  const intervalMs = Math.max(1, code.interval) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollRes = await fetch(`${DEFAULT_BACKEND_URL}/api/v1/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: code.device_code }),
    });
    if (pollRes.status === 410) {
      console.log("  Pairing code expired. Run `oked init` again.");
      return null;
    }
    if (!pollRes.ok) continue;
    const body = (await pollRes.json()) as { status: string; api_key?: string };
    if (body.status === "approved" && body.api_key) {
      return body.api_key;
    }
  }
  console.log("  Pairing timed out. Run `oked init` again.");
  return null;
}

async function init(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = readSettings(settingsPath);

  // Merge OKed hook into existing hooks
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse || []) as Array<{
    matcher?: string;
    hooks?: unknown[];
  }>;

  // Check if OKed hook already exists
  const hasOked = preToolUse.some((entry) =>
    entry.hooks?.some(
      (h: unknown) =>
        typeof h === "object" &&
        h !== null &&
        (h as Record<string, unknown>).command === "oked-hook"
    )
  );

  if (!hasOked) {
    preToolUse.push(HOOK_CONFIG);
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
    console.log("OKed hook installed.");
    console.log(`  Config: ${settingsPath}`);
  } else {
    console.log("OKed hook already configured.");
    console.log(`  Config: ${settingsPath}`);
  }

  // Already paired? Just ping and exit.
  const existingClient = new OKedClient();
  if (existingClient.apiKey) {
    const ok = await existingClient.ping();
    console.log("");
    console.log(`  API key: ${existingClient.apiKey.slice(0, 8)}... (already paired)`);
    console.log(`  Backend: ${existingClient.backendUrl} (${ok ? "connected" : "not reachable"})`);
    console.log("");
    console.log("Every Claude Code session in this project is now protected.");
    return;
  }

  // Pair this device.
  const apiKey = await pair("claude-code");
  if (!apiKey) return;

  writeOkedConfig(apiKey, DEFAULT_BACKEND_URL);
  console.log("");
  console.log(`  Paired. Key saved to ${OKED_CONFIG_PATH}`);
  console.log("");
  console.log("Every Claude Code session in this project is now protected.");
}

async function status(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = readSettings(settingsPath);

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse || []) as Array<{
    matcher?: string;
    hooks?: unknown[];
  }>;
  const hasOked = preToolUse.some((entry) =>
    entry.hooks?.some(
      (h: unknown) =>
        typeof h === "object" &&
        h !== null &&
        (h as Record<string, unknown>).command === "oked-hook"
    )
  );

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
    (entry) =>
      !entry.hooks?.some(
        (h: unknown) =>
          typeof h === "object" &&
          h !== null &&
          (h as Record<string, unknown>).command === "oked-hook"
      )
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

async function update(args: string[]): Promise<void> {
  if (args.includes("--rollback")) {
    const { from, to } = rollback();
    if (!to) {
      console.log("No prior version available to roll back to.");
      return;
    }
    console.log(`Rolled back: ${from ?? "(bundled)"} -> ${to}`);
    return;
  }
  if (args.includes("--pin")) {
    const idx = args.indexOf("--pin");
    const target = args[idx + 1];
    if (!target) {
      console.error("Usage: oked update --pin <version>");
      process.exit(1);
    }
    writeUpdateState({ pinnedVersion: target });
    console.log(`Pinned to ${target}. Auto-update is now disabled until you run \`oked update --unpin\`.`);
    return;
  }
  if (args.includes("--unpin")) {
    writeUpdateState({ pinnedVersion: undefined });
    console.log("Unpinned. Auto-update re-enabled.");
    return;
  }
  if (args.includes("--check")) {
    const result = await runUpdate({ force: true });
    console.log(`Installed: ${result.installedVersion}`);
    if (result.manifestVersion) console.log(`Latest:    ${result.manifestVersion}`);
    if (result.status === "error") console.log(`Error:     ${result.error}`);
    console.log(`Status:    ${result.status}`);
    return;
  }

  console.log(`Checking for updates...`);
  const result = await runUpdate({ force: true });
  switch (result.status) {
    case "updated":
      console.log(`OK Updated ${result.installedVersion} -> ${result.manifestVersion}`);
      break;
    case "up-to-date":
      console.log(`OK Already on the latest version (${result.installedVersion}).`);
      break;
    case "disabled":
      console.log(`Auto-update is disabled (latest known: ${result.manifestVersion ?? "?"}).`);
      break;
    case "pinned":
      console.log(`Pinned to ${result.manifestVersion ?? "?"} — skipping. Run \`oked update --unpin\` to re-enable.`);
      break;
    case "locked":
      console.log(`Another update is already in progress.`);
      break;
    case "error":
      console.error(`Update failed: ${result.error}`);
      process.exit(1);
      break;
    default:
      console.log(`Status: ${result.status}`);
  }
}

function versionCmd(): void {
  const running = getRunningVersion();
  const state = readUpdateState();
  console.log(`oked ${running}`);
  if (running !== SDK_VERSION) {
    console.log(`  bundled:    ${SDK_VERSION}`);
    console.log(`  managed:    ${running}`);
  }
  if (state.latestKnownVersion && state.latestKnownVersion !== running) {
    console.log(`  available:  ${state.latestKnownVersion}  (run 'oked update')`);
  }
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
  case "update":
    update(process.argv.slice(3)).catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  case "--version":
  case "-v":
  case "version":
    versionCmd();
    break;
  default:
    console.log("Usage: oked <command>");
    console.log("");
    console.log("Commands:");
    console.log("  init        Install OKed hooks in current project and pair this device");
    console.log("  status      Show current config and connection status");
    console.log("  uninstall   Remove OKed hooks from current project");
    console.log("  update      Check for and install the latest OKed CLI");
    console.log("  version     Print the installed version");
    console.log("");
    console.log("Update flags:");
    console.log("  oked update --check         Force a check (verbose) without prompting");
    console.log("  oked update --rollback      Revert to the previously-installed version");
    console.log("  oked update --pin <ver>     Pin to a version and disable auto-update");
    console.log("  oked update --unpin         Re-enable auto-update");
    break;
}
