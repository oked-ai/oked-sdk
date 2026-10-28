#!/usr/bin/env node
import { decide, errorInfo, logDecision } from "@oked/hook-core";
import { mapCodexTool } from "./map.js";
import { writeDecision } from "./output.js";
import { CLIENT_ID, PAIR_COMMAND, UNINSTALL_COMMAND } from "./version.js";

function invalidKeyReason(status: number): string {
  return `OKed: invalid API key (HTTP ${status}). Pair first: run \`${PAIR_COMMAND}\` to pair again, or \`${UNINSTALL_COMMAND}\` to remove OKed.`;
}

const UNPAIRED = `OKed: this device is not paired. Pair first: run ${PAIR_COMMAND}`;

function denyUnreadable(reason: string): void {
  writeDecision({ decision: "deny", reason });
  logDecision({
    decision: "deny",
    reason,
    tool: "unknown",
    tier: null,
    client: CLIENT_ID,
  });
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    denyUnreadable(`OKed: the hook input could not be read. Pair first: run ${PAIR_COMMAND}`);
    return;
  }

  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName) {
    denyUnreadable(`OKed: the hook input had no tool name. Pair first: run ${PAIR_COMMAND}`);
    return;
  }

  const mapped = mapCodexTool(toolName, input.tool_input);
  const decision = await decide(
    {
      toolName: mapped.toolName,
      toolInput: mapped.toolInput,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      sessionId: typeof input.session_id === "string" ? input.session_id : undefined,
    },
    {
      clientId: CLIENT_ID,
      source: "codex",
      unpaired: "deny",
      unpairedReason: UNPAIRED,
      unpairedLog: `not paired - pair first: run ${PAIR_COMMAND}`,
      invalidKeyReason,
    },
  );
  writeDecision(decision);
}

main().catch((err) => {
  const info = errorInfo(err);
  const reason = `OKed: internal error (fail-safe): ${info.name}: ${info.message}`;
  process.stderr.write(`[OKed] Fatal: ${err}\n`);
  writeDecision({ decision: "deny", reason });
  logDecision({
    decision: "deny",
    reason,
    tool: "unknown",
    tier: null,
    client: CLIENT_ID,
    error: info,
  });
  process.exit(0);
});
