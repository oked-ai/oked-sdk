#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { homedir, hostname } from "os";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { OKedClient, loadOKedConfig, OKED_CONFIG_PATH } from "@oked/sdk";

const MCP_TOOL_MATCHER = "mcp__.*";
const DEFAULT_TOOL_MATCHER = `Bash|Write|Edit|Agent|${MCP_TOOL_MATCHER}`;

const HOOK_CONFIG = {
  matcher: DEFAULT_TOOL_MATCHER,
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
const CLIENT_VERSION = "0.1.0";

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

function hasOkedCommandHook(entry: { hooks?: unknown[] }): boolean {
  return Boolean(
    entry.hooks?.some(
      (h: unknown) =>
        typeof h === "object" &&
        h !== null &&
        (h as Record<string, unknown>).command === "oked-hook"
    )
  );
}

function ensureMcpMatcher(matcher?: string): string | undefined {
  if (!matcher) return matcher;
  const parts = matcher.split("|").map((part) => part.trim());
  if (parts.some((part) => part === MCP_TOOL_MATCHER || part.startsWith("mcp__"))) {
    return matcher;
  }
  return `${matcher}|${MCP_TOOL_MATCHER}`;
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

  // Check if OKed hook already exists and upgrade older matchers to cover MCP
  // tools (`mcp__<server>__<tool>`) as regular PreToolUse events.
  let updatedOkedMatcher = false;
  const hasOked = preToolUse.some((entry) => {
    if (!hasOkedCommandHook(entry)) return false;
    const nextMatcher = ensureMcpMatcher(entry.matcher);
    if (nextMatcher !== entry.matcher) {
      entry.matcher = nextMatcher;
      updatedOkedMatcher = true;
    }
    return true;
  });

  if (!hasOked) {
    preToolUse.push(HOOK_CONFIG);
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
    console.log("OKed hook installed.");
    console.log(`  Config: ${settingsPath}`);
  } else if (updatedOkedMatcher) {
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
    console.log("OKed hook updated.");
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
  default:
    console.log("Usage: oked <command>");
    console.log("");
    console.log("Commands:");
    console.log("  init        Install OKed hooks in current project and pair this device");
    console.log("  status      Show current config and connection status");
    console.log("  uninstall   Remove OKed hooks from current project");
    break;
}
