import type { ReceiptKey, SignedReceipt } from "@oked/receipt-core";
import type { OkedMode } from "./mode.js";

export type RiskTier = "safe" | "warning" | "review" | "high_stakes";
export type { OkedMode };

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
  /** null when no request row exists (e.g. a request that timed out client-side). */
  approval_id: string | null;
  decision: "approved" | "denied" | "timeout";
  /**
   * The signed receipt for this decision, already verified: OKed's signature,
   * this request, this decision, and the exact action and nonce sent. Absent
   * for a deny or timeout that came without one (e.g. a client-side timeout),
   * or when requireReceipt is off and the backend sent none.
   */
  receipt?: SignedReceipt;
}

export interface OKedConfig {
  apiKey: string;
  backendUrl: string;
  /**
   * How long to wait for a human decision, in ms. Default 630_000 (10.5 min);
   * see DEFAULT_APPROVAL_TIMEOUT_MS.
   *
   * Three timers nest around one approval: the backend's own expiry (which
   * returns `decision: "timeout"`), this client-side abort, and - under a
   * harness that kills the hook process - the harness limit. They must stay
   * ordered backend < this < harness. Raise this and the harness limit has to
   * move with it, or the process is killed before the fail-safe deny is
   * written and the gate falls open instead of denying.
   */
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
   * `enforce` (default) pauses review and high_stakes actions until a person
   * decides. `watch` lets those actions run and records that they would have
   * paused. Constructor, then OKED_MODE, then ~/.oked/config.json, then enforce.
   * `approve()` itself still waits: automatic gates read this field.
   */
  mode: OkedMode;
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
  /**
   * Deny an approval that arrives without a receipt. A receipt that is present
   * but does not verify always denies, whatever this says. Default true (since
   * 0.6.0); set false, or env OKED_REQUIRE_RECEIPT=0, only for a backend that
   * does not sign receipts.
   */
  requireReceipt: boolean;
  /**
   * Where to fetch receipt keys the SDK has not seen. Default OKed's published
   * set (https://api.oked.ai/.well-known/oked-receipt-keys.json), independent
   * of backendUrl. https only, except loopback for local dev. Env
   * OKED_RECEIPT_KEYS_URL.
   */
  receiptKeysUrl: string;
  /** Verify with exactly these keys and never fetch (tests, self-hosted backends). */
  receiptKeys?: ReceiptKey[];
  /** The integration asking, e.g. "@oked/claude-code@0.5.0". Recorded in receipts. */
  client?: string;
  /** Where the request comes from, e.g. "claude-code". Part of the receipt's subject. Default "sdk". */
  source?: string;
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
