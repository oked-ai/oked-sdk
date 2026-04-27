export type RiskTier = "safe" | "warning" | "normal" | "high_stakes";

export interface ApprovalRequest {
  action: string;
  description: string;
  tier: RiskTier;
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
