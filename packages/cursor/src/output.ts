import type { GateDecision } from "@oked/hook-core";

/**
 * Cursor `preToolUse` output. `allow` and `deny` are enforced.
 * `ask` is accepted by the schema and not enforced, so a non-allow is deny.
 */
export function writeDecision(decision: GateDecision): void {
  if (decision.decision === "allow") {
    const out: Record<string, string> = { permission: "allow" };
    if (decision.reason) out.user_message = decision.reason;
    process.stdout.write(JSON.stringify(out));
    return;
  }
  const reason = decision.reason || "OKed denied this action.";
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      user_message: reason,
      agent_message: reason,
    }),
  );
}
