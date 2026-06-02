export type RiskTier = "safe" | "warning" | "review" | "high_stakes";

export interface ApprovalRequest {
  action: string;
  description: string;
  tier: RiskTier;
  fields?: Record<string, string>;
  tool_input?: unknown;
  session_id?: string;
  cwd?: string;
}

export interface ApprovalResponse {
  approved: boolean;
  approval_id: string;
  decision: "approved" | "denied" | "timeout";
}

export interface OKedConfig {
  apiKey: string;
  backendUrl: string;
  timeout: number;
  /**
   * When true, an unreachable backend hard-denies every sensitive action
   * (the original fail-safe behavior). When false (default), an unreachable
   * backend degrades to "allow" for non-high-stakes tiers so a single outage
   * does not mass-abort every user's agent. `high_stakes` always denies on
   * outage regardless of this flag. See degradedDecision().
   */
  strictFailClosed: boolean;
  /**
   * TTL (ms) for the on-disk cache of user rules used by the hook's local
   * escalation check. The Claude Code hook is a fresh process per tool call,
   * so the cache lives on disk; a longer TTL means fewer fetches at the cost
   * of slower rule propagation. Default 300_000 (5 min).
   */
  rulesCacheTtlMs: number;
  /**
   * Min interval (ms) between heartbeats. The hook fires a lightweight ping so
   * the backend knows the install is still alive (feeds retention analytics)
   * even for users who only run safe/warning actions. Throttled on disk
   * (~/.oked/heartbeat.json) because the hook is a fresh process per call.
   * Default 86_400_000 (once per day).
   */
  heartbeatIntervalMs: number;
}

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
}
