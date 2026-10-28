import type { GateDecision } from "@oked/hook-core";

/**
 * Codex continues when a PreToolUse hook prints nothing.
 * `permissionDecision: "allow"` without `updatedInput` is an unsupported
 * decision: Codex logs it and still runs the tool. `ask` is unsupported the
 * same way. Deny is the only decision this hook prints.
 */
export function writeDecision(decision: GateDecision): void {
  if (decision.decision === "allow") return;
  const reason = decision.reason || "OKed denied this action.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}
