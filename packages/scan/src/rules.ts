import { CLASSIFIER_VERSION, classify, describeFields, type RiskTier } from "@oked/sdk";

export type Host = "claude-code" | "codex";

/**
 * Shell tool names the Codex hook maps onto Bash before `classify()`.
 * `Bash` is included because the hook treats that name the same way.
 * Keep this set in sync with `SHELL_NAMES` in `packages/codex/src/map.ts`.
 */
export const SHELL_TOOL_NAMES = new Set([
  "Bash",
  "bash",
  "shell",
  "exec",
  "exec_command",
  "shell_command",
  "local_shell",
  "container.exec",
]);

export const PAUSED_TIERS = new Set<RiskTier>(["review", "high_stakes"]);

export function pausesForApproval(tier: RiskTier): boolean {
  return PAUSED_TIERS.has(tier);
}

/**
 * Same `classify()` the hooks call.
 * Claude Code passes `sandboxEnforced: false` when the Bash sandbox is not
 * containing child processes. That is the default (the sandbox is off unless
 * the user turns it on). Codex omits the option, so test runners stay allowed.
 * Custom user rules are not applied.
 */
export function classifyCommand(host: Host, command: string): { tier: RiskTier; category: string } {
  const options = host === "claude-code" ? { sandboxEnforced: false as const } : undefined;
  let tier: RiskTier = "review";
  try {
    tier = classify("Bash", { command }, options);
  } catch {
    tier = "review";
  }
  let category = "unknown_bash";
  try {
    const fields = describeFields("Bash", { command }, options ?? {});
    if (fields?.Kind) category = fields.Kind;
  } catch {
    category = "unknown_bash";
  }
  return { tier, category };
}

export function classifierVersion(): string {
  return CLASSIFIER_VERSION;
}
