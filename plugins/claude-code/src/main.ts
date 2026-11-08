/**
 * Claude Code plugin hook. Bundled to scripts/oked-hook.mjs.
 * `node oked-hook.mjs` is the PreToolUse hook. `node oked-hook.mjs pair` pairs.
 *
 * PreToolUse output is deny, ask, or no decision. No decision leaves the call
 * to Claude Code's normal permission flow (exit 0 and no permissionDecision).
 * This hook never returns permissionDecision "allow" and never sets updatedInput.
 */
import { spawn } from "child_process";
import { decide, errorInfo, logDecision, maskKey, pairDevice, pluginHookYieldsToSettingsHook } from "@oked/hook-core";
import type { HookInput } from "@oked/sdk";

const PLUGIN_VERSION = __OKED_PLUGIN_VERSION__;
const CLIENT_ID = __OKED_CLIENT_ID__;
const DEFAULT_BACKEND_URL = process.env.OKED_BACKEND_URL || "https://api.oked.ai";

function pluginOption(name: "CLAUDE_PLUGIN_OPTION_APIKEY" | "CLAUDE_PLUGIN_OPTION_GITHUBTOKEN"): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function errorText(err: unknown): string {
  const info = errorInfo(err);
  return `${info.name}: ${info.message}`;
}

/**
 * Deny or ask. "pass" writes no permissionDecision, so Claude Code's normal
 * permission flow applies. That is the path for a safe call and for a call
 * a person already approved. It is not an approval of the tool call.
 */
function writeDecision(decision: "pass" | "deny" | "ask", reason?: string): void {
  if (decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason || "OKed denied this action.",
        },
      }),
    );
    return;
  }
  if (decision === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: reason || "OKed needs a decision in Claude Code.",
        },
      }),
    );
    return;
  }
  // No permissionDecision. Exit 0 with no decision leaves the call to Claude
  // Code's normal permission flow. decide() already logged an approval or a
  // degraded pass on stderr. Do not write JSON here.
  void reason;
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function runHook(): Promise<void> {
  let rawInput = "";
  try {
    rawInput = await readStdin();
  } catch {
    rawInput = "";
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput) as HookInput;
  } catch {
    writeDecision("pass");
    return;
  }

  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const cwd = input.cwd || process.cwd();
  if (pluginHookYieldsToSettingsHook(toolName, cwd)) {
    process.stderr.write(
      "[OKed] oked-hook in Claude settings is gating this call. The plugin hook is standing down.\n",
    );
    writeDecision("pass");
    return;
  }

  const apiKey = pluginOption("CLAUDE_PLUGIN_OPTION_APIKEY");
  const githubToken = pluginOption("CLAUDE_PLUGIN_OPTION_GITHUBTOKEN");
  const decision = await decide(
    {
      toolName: input.tool_name,
      toolInput: input.tool_input as Record<string, unknown>,
      cwd: input.cwd,
      sessionId: input.session_id,
    },
    {
      clientId: CLIENT_ID,
      source: "claude-code",
      ...(apiKey ? { apiKey } : {}),
      ...(githubToken ? { githubToken } : {}),
      unpaired: "ask",
      unpairedReason: "OKed: this device is not paired. Run /oked:pair, then save the API key in the plugin configuration.",
      unpairedLog: "not paired. Run /oked:pair, then set the API key. Falling back to Claude's built-in prompt.",
      invalidKeyReason: (status) =>
        `OKed: invalid API key (HTTP ${status}). Run /oked:pair and update the API key in the plugin configuration.`,
    },
  );
  if (decision.decision === "deny") writeDecision("deny", decision.reason);
  else if (decision.decision === "ask") writeDecision("ask", decision.reason);
  else writeDecision("pass", decision.reason);
}

function savePluginConfig(apiKey: string): Promise<boolean> {
  const payload = JSON.stringify({ apiKey });
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn("claude", ["plugin", "configure", "oked@oked", "--values-stdin"], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
      child.stdin?.on("error", () => {});
      child.stdin?.end(payload);
    } catch {
      done(false);
    }
  });
}

async function runPair(): Promise<void> {
  const noBrowser = process.argv.includes("--no-browser");
  const apiKey = await pairDevice({
    backendUrl: DEFAULT_BACKEND_URL,
    clientType: "claude-code",
    clientVersion: PLUGIN_VERSION,
    noBrowser,
    retryCommand: "/oked:pair",
    scanLine: "  Or scan this with your phone camera:",
    footerLines: (verificationUri) => [
      `  (Or visit ${verificationUri} and enter the code above.)`,
      "  Approve in Telegram or on the web dashboard. The iPhone app is coming soon.",
    ],
  });
  if (!apiKey) return;

  const saved = await savePluginConfig(apiKey);
  console.log("");
  if (saved) {
    console.log(`  Paired. API key ${maskKey(apiKey)} saved to the plugin configuration.`);
    console.log("  Start a new Claude Code session so the hook sees the key.");
    return;
  }
  console.log("  Claude Code could not store the plugin API key from here.");
  console.log("  Paste this key into the OKed plugin API key field (/plugin configure oked@oked):");
  console.log(`    ${apiKey}`);
  console.log("  Do not paste the key into the chat. Start a new session after you save it.");
}

function printUsage(): void {
  process.stdout.write("Usage: node oked-hook.mjs [pair]\n");
  process.stdout.write("  (no args)   PreToolUse hook. Reads Claude Code JSON on stdin.\n");
  process.stdout.write("  pair        Pair this machine and save the API key.\n");
  process.stdout.write("    --no-browser  Print the pairing link. Open no browser.\n");
}

const command = process.argv[2];
if (command === "--help" || command === "-h") {
  printUsage();
} else if (command === "pair") {
  runPair().catch((err) => {
    process.stderr.write(`[OKed] ${errorText(err)}\n`);
    process.exitCode = 1;
  });
} else if (command === undefined) {
  runHook().catch((err) => {
    process.stderr.write(`[OKed] Fatal: ${err}\n`);
    const reason = `OKed: internal error (fail-safe): ${errorText(err)}`;
    writeDecision("deny", reason);
    logDecision({
      decision: "deny",
      reason,
      tool: "unknown",
      tier: null,
      client: CLIENT_ID,
      error: errorInfo(err),
    });
    process.exitCode = 0;
  });
} else {
  printUsage();
  process.exitCode = 1;
}
