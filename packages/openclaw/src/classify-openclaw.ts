import { classify as classifyClaude, type RiskTier } from "@oked/sdk";

/**
 * OpenClaw-aware risk classifier.
 *
 * OpenClaw skills register tools with names like `imessage_send`, `phone_call`,
 * `deploy_site`, `email_send`. Names that the @oked/sdk Claude-Code classifier
 * doesn't recognize. We layer a suffix/prefix heuristic for OpenClaw skill
 * conventions on top of the @oked/sdk classifier so well-known sensitive
 * patterns (send, dial, deploy, charge, delete) trip approval automatically.
 *
 * Plugin users can override or extend behavior via plugin config:
 *   {
 *     "alwaysApprove": ["custom_tool_name", ...],
 *     "alwaysAllow":   ["safe_tool_name",  ...]
 *   }
 */

const SAFE_PATTERNS = [
  /^get_/,
  /^list_/,
  /^search_/,
  /^read_/,
  /^find_/,
  /^show_/,
  /^check_/,
  /^view_/,
  /^describe_/,
  /^inspect_/,
];

const HIGH_STAKES_PATTERNS = [
  // Communication that touches the real world
  /(_|^)(send|reply|post|publish|broadcast|email|sms|imessage|whatsapp|slack|telegram|tweet|toot)$/,
  /(_|^)(send|reply|post|publish|email|sms|imessage|whatsapp|slack|telegram|tweet)_/,
  // Telephony
  /(_|^)(call|dial|hangup|phone)$/,
  /(_|^)(call|dial|hangup|phone)_/,
  // Money / commerce
  /(_|^)(charge|pay|transfer|refund|invoice|purchase|buy|sell)$/,
  /(_|^)(charge|pay|transfer|refund|invoice|purchase|buy|sell)_/,
  // Destructive
  /(_|^)(delete|drop|destroy|wipe|truncate|remove)$/,
  /(_|^)(delete|drop|destroy|wipe|truncate|remove)_/,
  // Deploys / external publishing
  /(_|^)(deploy|publish|release|launch|ship)$/,
  /(_|^)(deploy|publish|release|launch|ship)_/,
  // Account / identity changes
  /(_|^)(rename|reset_password|revoke|grant|invite_user|remove_user)$/,
  // Calendar / scheduling
  /(_|^)(schedule_meeting|cancel_meeting|book|reschedule)$/,
];

const REVIEW_PATTERNS = [
  /(_|^)(create|update|edit|write|modify|patch|set)$/,
  /(_|^)(create|update|edit|write|modify|patch|set)_/,
  /(_|^)(rename|move|copy)_/,
];

export interface ClassifyOptions {
  alwaysApprove?: ReadonlyArray<string>;
  alwaysAllow?: ReadonlyArray<string>;
}

export function classifyOpenClawTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: ClassifyOptions,
): RiskTier {
  const lower = toolName.toLowerCase();

  if (opts?.alwaysAllow?.includes(toolName)) return "safe";
  if (opts?.alwaysApprove?.includes(toolName)) return "high_stakes";

  // Bash / shell / exec: defer to the SDK's bash classifier.
  if (lower === "bash" || lower === "shell" || lower === "exec") {
    return classifyClaude(
      "Bash",
      toolInput as Record<string, unknown>,
    );
  }

  for (const re of SAFE_PATTERNS) {
    if (re.test(lower)) return "safe";
  }

  for (const re of HIGH_STAKES_PATTERNS) {
    if (re.test(lower)) return "high_stakes";
  }

  for (const re of REVIEW_PATTERNS) {
    if (re.test(lower)) return "review";
  }

  return "review";
}
