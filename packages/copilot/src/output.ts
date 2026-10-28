import type { GateDecision } from "@oked/hook-core";

/**
 * Copilot reads a top-level `permissionDecision`. Empty output uses the
 * host's normal permission flow, which can still prompt, so an allow is
 * explicit. `ask` becomes deny in cloud agent and in CLI autopilot, so a
 * non-allow is deny here too.
 */
export function writeDecision(decision: GateDecision): void {
  const permissionDecision = decision.decision === "allow" ? "allow" : "deny";
  const out: Record<string, string> = { permissionDecision };
  if (decision.reason) out.permissionDecisionReason = decision.reason;
  else if (permissionDecision === "deny") out.permissionDecisionReason = "OKed denied this action.";
  process.stdout.write(JSON.stringify(out));
}
