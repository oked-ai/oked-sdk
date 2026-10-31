import type { ApprovalRequest, ApprovalResponse, OkedMode, RiskTier, Rule } from "@oked/sdk";

/**
 * Enough of `OKedClient` for the gate. Pass `new OKedClient()` or a test double.
 * `apiKey` and `timeoutMs` on {@link OkedAiOptions} apply only when `client` is omitted.
 */
export interface OkedGateClient {
  readonly apiKey: string;
  readonly strictFailClosed?: boolean;
  /** Resolved mode, when the client is an `OKedClient`. */
  readonly mode?: OkedMode;
  approve(request: ApprovalRequest): Promise<ApprovalResponse>;
  getRules?(): Promise<Rule[]>;
  heartbeat?(): Promise<void>;
}

export interface OkedAiOptions {
  /**
   * Client to call. When omitted, a new `OKedClient` is created from
   * `OKED_API_KEY` or `~/.oked/config.json`.
   */
  client?: OkedGateClient;
  /** Used only when `client` is omitted. */
  apiKey?: string;
  /**
   * How long to wait for a person, in milliseconds. Used only when `client`
   * is omitted. Default is the SDK wait, 630 seconds. A timeout denies.
   */
  timeoutMs?: number;
  /**
   * When true, an unreachable backend denies every sensitive tool. When false,
   * it denies `high_stakes` only. Overrides `client.strictFailClosed` when set.
   * Env: `OKED_STRICT_FAIL_CLOSED=1`.
   */
  strictFailClosed?: boolean;
  /**
   * Lowest tier that waits for a person. Default `review` (env `OKED_MIN_TIER`).
   * `safe` and `warning` still run locally unless `alwaysApprove` lists the
   * tool or a saved rule matches.
   */
  minTier?: RiskTier;
  /**
   * `watch` lets a risky call run and records that it would have paused.
   * `enforce` (default) waits. `OKED_MODE`, then `~/.oked/config.json`.
   */
  mode?: OkedMode;
  /** Tool names that always wait for a person, whatever the classifier says. */
  alwaysApprove?: readonly string[];
  /** Tool names that always run, with no approval request. Wins over `alwaysApprove`. */
  alwaysAllow?: readonly string[];
  /** Working directory recorded on the approval. Default `process.cwd()`. */
  cwd?: string;
  /**
   * Receipt session id. When omitted, the AI SDK tool call id is used so
   * each call can be told apart.
   */
  sessionId?: string;
  /**
   * Receipt subject source. Default `ai-sdk`. Used only when `client` is omitted.
   */
  source?: string;
  /** Line logger. Default writes `[OKed] ...` to stderr. The message has no prefix. */
  log?: (message: string) => void;
}

/** What the gate decided. Local allows are not recorded as approvals. */
export type OkedGateResult =
  | { action: "allow"; recorded: false }
  | { action: "allow"; recorded: true; reason: string }
  | {
      action: "deny";
      decision: "denied" | "timeout" | "error";
      approvalId: string | null;
      reason: string;
      tier: RiskTier;
    };

/**
 * Value returned from a wrapped `execute` when the tool did not run.
 * `reason` is the text to show the model.
 */
export interface OkedDenial {
  oked: "denied";
  decision: "denied" | "timeout" | "error";
  approvalId: string | null;
  reason: string;
  tier: RiskTier;
}

/**
 * Subset of an AI SDK tool call. AI SDK 7 uses `input`. `args` is accepted
 * when `input` is missing.
 */
export interface OkedToolCall {
  toolName: string;
  input?: unknown;
  args?: unknown;
  toolCallId?: string;
  dynamic?: boolean;
}

/**
 * Arguments of an AI SDK 7 `GenericToolApprovalFunction`. Extra fields the
 * SDK passes (`tools`, `messages`, `runtimeContext`) are ignored.
 */
export interface OkedToolApprovalArgs {
  toolCall?: OkedToolCall;
}

/**
 * Status object AI SDK 7 accepts from `toolApproval`. This package never
 * returns `user-approval`: that ends the generation and leaves the tool
 * runnable on the next call.
 */
export type OkedToolApprovalResult =
  | undefined
  | { type: "approved"; reason?: string }
  | { type: "denied"; reason: string };

export type OkedToolApprovalFunction = (
  args: OkedToolApprovalArgs,
) => Promise<OkedToolApprovalResult>;

/** Per-tool `toolApproval` callback. The tool name is bound by the caller. */
export type OkedSingleToolApproval = (
  input: unknown,
  options?: { toolCallId?: string },
) => Promise<OkedToolApprovalResult>;

export type ToolExecute = (input: unknown, options?: unknown) => unknown;
