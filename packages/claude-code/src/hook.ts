#!/usr/bin/env node
import { decide, errorInfo, logDecision, settingsHookYieldsToPlugin } from "@oked/hook-core";
import type { HookInput, HookOutput } from "@oked/sdk";
import { CLIENT_ID } from "./version.js";

function makeOutput(
  decision: "allow" | "deny" | "ask",
  reason?: string,
): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason && { permissionDecisionReason: reason }),
    },
  };
}

function errorText(err: unknown): string {
  const info = errorInfo(err);
  return `${info.name}: ${info.message}`;
}

async function main(): Promise<void> {
  // Read hook input from stdin
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    // Can't parse input - don't break Claude, let it through
    process.stdout.write(JSON.stringify(makeOutput("allow")));
    return;
  }

  // The Claude Code plugin gates this call when it is enabled and its hook
  // file is installed. Returning allow here does not approve the action:
  // the plugin's decision wins, and ask or deny from the plugin still applies.
  if (settingsHookYieldsToPlugin(input.cwd || process.cwd())) {
    process.stderr.write(
      "[OKed] Claude Code plugin is enabled. This settings hook is not gating, so the action is asked once.\n",
    );
    process.stdout.write(JSON.stringify(makeOutput("allow")));
    return;
  }

  const decision = await decide(
    {
      toolName: input.tool_name,
      // Pass tool_input through. Replacing a missing value with {} makes Bash
      // and Write look safe, and the hook would allow them. 0.6.21 did not
      // coerce it: classify threw, and the fail-safe handler denied.
      toolInput: input.tool_input as Record<string, unknown>,
      cwd: input.cwd,
      sessionId: input.session_id,
    },
    {
      clientId: CLIENT_ID,
      source: "claude-code",
      unpaired: "ask",
      unpairedReason: "OKed: this device is not paired. Run `oked init`.",
      unpairedLog: "not paired - run `oked init` to pair this device. Falling back to Claude's built-in prompt.",
    },
  );
  process.stdout.write(JSON.stringify(makeOutput(decision.decision, decision.reason)));
}

main().catch((err) => {
  process.stderr.write(`[OKed] Fatal: ${err}\n`);
  const reason = `OKed: internal error (fail-safe): ${errorText(err)}`;
  process.stdout.write(JSON.stringify(makeOutput("deny", reason)));
  logDecision({
    decision: "deny",
    reason,
    tool: "unknown",
    tier: null,
    client: CLIENT_ID,
    error: errorInfo(err),
  });
  process.exit(0); // exit 0 so Claude reads our JSON, not a crash
});
