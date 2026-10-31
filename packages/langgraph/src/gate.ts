/**
 * Decide whether one LangChain tool call may run.
 *
 * The wait is `OKedClient.approve()`, the same call the other integrations
 * use. LangGraph's `interrupt()` is a different mechanism: it pauses the
 * graph until the caller resumes it, and that caller is not the person on
 * Telegram or the dashboard. Gating here, before the tool body, needs no
 * checkpointer and cannot be skipped by resuming the graph.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OKedClient,
  applyRules,
  classify,
  degradedDecision,
  describe,
  describeFields,
  lookupPrTitle,
  TIER_ORDER,
  effectiveMode,
  recordWouldHavePaused,
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
  type ApprovalRequest,
  type ApprovalResponse,
  type OkedMode,
  type RiskTier,
  type Rule,
  type WatchReason,
} from "@oked/sdk";

const CLIENT_ID = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return `@oked/langgraph@${JSON.parse(readFileSync(pkgPath, "utf-8")).version}`;
  } catch {
    return "@oked/langgraph";
  }
})();

const APPROVAL_TIERS: ReadonlySet<RiskTier> = new Set(["review", "high_stakes"]);

const TIERS: ReadonlySet<string> = new Set(["safe", "warning", "review", "high_stakes"]);

function isTier(value: unknown): value is RiskTier {
  return typeof value === "string" && TIERS.has(value);
}

/**
 * Enough of `OKedClient` for the gate. Tests pass a fake. Application code
 * can omit `client` and let the wrapper build one.
 */
export interface OkedApprovalClient {
  readonly apiKey: string;
  readonly strictFailClosed: boolean;
  readonly mode?: OkedMode;
  approve(request: ApprovalRequest): Promise<ApprovalResponse>;
  heartbeat(): Promise<void>;
  getRules(): Promise<Rule[]>;
}

/**
 * A LangChain tool, or any object ToolNode can call. The wrapper keeps the
 * original object and only replaces execution.
 */
export interface OkedToolLike {
  name: string;
  description?: string;
  schema?: unknown;
  // LangChain invoke signatures differ by schema. The wrapper calls through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (...args: any[]) => any;
}

export interface OkedLangGraphOptions {
  /** OKed API key. Defaults to `OKED_API_KEY`, then `~/.oked/config.json`. */
  apiKey?: string;
  /** How long to wait for a person, in milliseconds. Default 630000. */
  timeoutMs?: number;
  /**
   * When true, an unreachable backend denies every sensitive tool. When
   * false (default), only `high_stakes` is denied during an outage.
   * `OKED_STRICT_FAIL_CLOSED=1` sets the same flag on a client this package
   * constructs.
   */
  strictFailClosed?: boolean;
  /**
   * Lowest tier that waits for a person. Default `review` (so `safe` and
   * `warning` run). `OKED_MIN_TIER` is used when this is omitted. Only
   * `review` and `high_stakes` ever wait; `warning` is logged and runs.
   */
  minTier?: RiskTier;
  /**
   * `watch` lets a risky call run and records that it would have paused.
   * `enforce` (default) waits. `OKED_MODE`, then `~/.oked/config.json`.
   */
  mode?: OkedMode;
  /** Tool names that always wait, at tier `high_stakes`. Exact match. */
  alwaysApprove?: readonly string[];
  /** Tool names that never wait. Exact match. The tool runs. */
  alwaysAllow?: readonly string[];
  /**
   * Use this tier instead of the classifier. `alwaysAllow` and
   * `alwaysApprove` still win. `safe` and `warning` run without a prompt
   * unless a cached user rule matches.
   */
  tier?: RiskTier;
  /** Recorded on the approval. Wins over `config.configurable.thread_id`. */
  sessionId?: string;
  /** Recorded on the approval. Default `process.cwd()`. */
  cwd?: string;
  /**
   * LangGraph runnable config from `tool.invoke`. When `sessionId` is unset,
   * `configurable.thread_id` (then `configurable.session_id`) is the session.
   */
  config?: unknown;
  /** Receives log lines. Default writes `[OKed] ...` to stderr. */
  log?: (msg: string) => void;
  /**
   * Client to use. Omit this in application code. Tests pass a fake with
   * `approve`, `getRules`, and `heartbeat`.
   */
  client?: OkedApprovalClient;
}

export interface OkedGateResult {
  /** When true, the original tool may run. When false, it must not. */
  run: boolean;
  tier: RiskTier;
  /** Set when `run` is false. Show this to the model. The tool did not run. */
  message?: string;
  decision?: "approved" | "denied" | "timeout";
  approvalId?: string | null;
  /** True when an unreachable backend allowed a non-high-stakes action. */
  degraded?: boolean;
}

function defaultLog(msg: string): void {
  process.stderr.write(`[OKed] ${msg}\n`);
}

function blocked(lead: string): string {
  return `${lead} This action was not run. Do NOT retry the same action. Stop and ask the user what to do instead.`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Arguments the model sent, whether `invoke` got a tool call or raw input. */
export function toolInputRecord(input: unknown): Record<string, unknown> {
  if (isRecord(input) && input.type === "tool_call" && "args" in input) {
    const args = input.args;
    if (isRecord(args)) return args;
    if (typeof args === "string") return { input: args };
    return { input: args };
  }
  if (isRecord(input)) return input;
  if (typeof input === "string") return { input };
  return { input };
}

function resolveMinTier(options: OkedLangGraphOptions | undefined): RiskTier {
  const fromOptions = options?.minTier;
  if (isTier(fromOptions)) return fromOptions;
  const env = process.env.OKED_MIN_TIER;
  if (isTier(env)) return env;
  return "review";
}

function resolveTier(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: OkedLangGraphOptions | undefined,
): RiskTier {
  if (options?.alwaysAllow?.includes(toolName)) return "safe";
  if (options?.alwaysApprove?.includes(toolName)) return "high_stakes";
  const override = options?.tier;
  if (isTier(override)) return override;
  return classify(toolName, toolInput);
}

function sessionIdOf(options: OkedLangGraphOptions | undefined): string | undefined {
  if (options?.sessionId) return options.sessionId;
  const config = options?.config;
  if (!isRecord(config)) return undefined;
  const configurable = config.configurable;
  if (!isRecord(configurable)) return undefined;
  if (typeof configurable.thread_id === "string" && configurable.thread_id) {
    return configurable.thread_id;
  }
  if (typeof configurable.session_id === "string" && configurable.session_id) {
    return configurable.session_id;
  }
  return undefined;
}

function cwdOf(options: OkedLangGraphOptions | undefined): string {
  return options?.cwd ?? process.cwd();
}

function summaryOf(toolName: string, toolInput: Record<string, unknown>): string {
  const summary = toolInput.file_path ?? toolInput.path ?? toolInput.command ?? toolInput.cmd ?? toolName;
  return typeof summary === "string" ? summary : toolName;
}

/**
 * Build the client the gate uses when the caller did not pass one.
 * `source` is `langgraph`, which is part of the receipt subject.
 */
export function createOkedClient(options?: OkedLangGraphOptions): OKedClient {
  return new OKedClient({
    ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options?.strictFailClosed !== undefined ? { strictFailClosed: options.strictFailClosed } : {}),
    client: CLIENT_ID,
    source: "langgraph",
    ...(options?.mode ? { mode: options.mode } : {}),
  });
}

function clientOf(options: OkedLangGraphOptions | undefined): OkedApprovalClient {
  return options?.client ?? createOkedClient(options);
}

async function rulesWantBackend(
  client: OkedApprovalClient,
  tier: RiskTier,
  fields: Record<string, string> | undefined,
  cwd: string,
): Promise<boolean> {
  if (!client.apiKey) return false;
  try {
    const rules = await client.getRules();
    if (rules.length === 0) return false;
    const decision = applyRules({ tier, fields: fields ?? {} }, rules, { cwd });
    return Boolean(decision.appliedRuleId);
  } catch {
    // A failed rules lookup must not block a tool that would otherwise run.
    return false;
  }
}

/**
 * Classify one tool call and, when the tier needs a person, wait.
 * `run: false` means the tool body must not run. The message is for the model.
 * Safe and warning calls run unless a cached user rule matches, in which case
 * the backend decides. No API key denies, because LangGraph would run the tool.
 * A denial, a timeout, a bad receipt, a bad key, and any unexpected error deny.
 * An unreachable backend follows `degradedDecision`.
 */
export async function gateToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  options?: OkedLangGraphOptions,
): Promise<OkedGateResult> {
  const log = options?.log ?? defaultLog;
  const client = clientOf(options);
  const cwd = cwdOf(options);

  if (client.apiKey) void client.heartbeat().catch(() => {});

  let tier: RiskTier;
  try {
    tier = resolveTier(toolName, toolInput, options);
  } catch (err) {
    log(`classifier error on ${toolName}: ${errorText(err)}`);
    return {
      run: false,
      tier: "review",
      message: blocked(`OKed: could not classify ${toolName} (${errorText(err)}).`),
    };
  }

  const minTier = resolveMinTier(options);
  const needsApproval = APPROVAL_TIERS.has(tier) && TIER_ORDER[tier] >= TIER_ORDER[minTier];
  let fields = describeFields(toolName, toolInput, { cwd }) ?? undefined;

  let fromRule = false;
  if (!needsApproval) {
    const escalated = await rulesWantBackend(client, tier, fields, cwd);
    if (!escalated) {
      if (tier === "warning") {
        log(`WARNING ${toolName} ${summaryOf(toolName, toolInput)} - allowed (inside project)`);
      }
      return { run: true, tier };
    }
    fromRule = true;
  }

  if (effectiveMode(options?.mode, client.mode) === "watch") {
    const reason: WatchReason = !client.apiKey
      ? "would have paused (not paired)"
      : fromRule
        ? "would have paused (saved rule)"
        : "would have paused";
    recordWouldHavePaused({
      tool: toolName,
      tier,
      client: CLIENT_ID,
      source: "langgraph",
      reason,
    });
    log(`watch: ${toolName} (${tier}) ${reason}. Allowed.`);
    return { run: true, tier };
  }

  if (!client.apiKey) {
    log(`no API key - denying ${toolName}`);
    return {
      run: false,
      tier,
      message: blocked(
        `OKed: no API key is configured for ${toolName}. Set OKED_API_KEY, or put an apiKey in ~/.oked/config.json.`,
      ),
    };
  }

  try {
    const prTitle = await lookupPrTitle(fields);
    if (prTitle) fields = describeFields(toolName, toolInput, { cwd, prTitle }) ?? undefined;
    const description = describe(toolName, toolInput, { cwd, prTitle });
    log(`${toolName}: "${description}" - ${tier}`);
    log("Requesting approval... (Telegram or the web dashboard)");

    const result = await client.approve({
      action: toolName,
      description,
      tier,
      fields,
      tool_input: toolInput,
      session_id: sessionIdOf(options),
      cwd,
    });

    if (result.approved) {
      log(`Approved (${result.approval_id})`);
      return { run: true, tier, decision: "approved", approvalId: result.approval_id };
    }
    if (result.decision === "timeout") {
      log(result.approval_id ? `No decision in time (${result.approval_id})` : "No decision in time");
      const idNote = result.approval_id ? ` (approval ${result.approval_id})` : "";
      return {
        run: false,
        tier,
        decision: "timeout",
        approvalId: result.approval_id,
        message: blocked(
          `USER did not respond to ${toolName} via OKed${idNote}. The approval window expired.`,
        ),
      };
    }
    log(`Denied (${result.approval_id})`);
    const idNote = result.approval_id ? ` (approval ${result.approval_id})` : "";
    return {
      run: false,
      tier,
      decision: "denied",
      approvalId: result.approval_id,
      message: blocked(
        `USER DENIED ${toolName} via OKed${idNote}. This is a final human decision.`,
      ),
    };
  } catch (err) {
    if (err instanceof OKedReceiptError) {
      log(`Approval receipt did not verify (${err.problems.join(", ")}) - action denied`);
      return {
        run: false,
        tier,
        message: blocked(
          `OKed: the approval receipt for ${toolName} did not verify (${err.problems.join(", ")}).`,
        ),
      };
    }
    if (err instanceof OKedAuthError) {
      log(`Invalid API key (HTTP ${err.status}) - action denied`);
      return {
        run: false,
        tier,
        message: blocked(
          `OKed: invalid API key for ${toolName} (HTTP ${err.status}). This is a configuration error, not a transient failure.`,
        ),
      };
    }
    if (err instanceof OKedTooManyPendingError) {
      log("Too many pending approvals (HTTP 429) - action denied");
      return { run: false, tier, message: blocked(err.message) };
    }
    if (err instanceof OKedHttpError) {
      log(`Backend error HTTP ${err.status} - action denied (fail-safe)`);
      return {
        run: false,
        tier,
        message: blocked(
          `OKed: backend error HTTP ${err.status}${err.detail ? `: ${err.detail}` : ""} (fail-safe).`,
        ),
      };
    }
    if (err instanceof OKedBackendUnreachableError) {
      const decision = degradedDecision(tier, { strictFailClosed: client.strictFailClosed });
      if (decision === "allow") {
        log(`Backend unreachable - ${toolName} (${tier}) allowed (degraded; non-high-stakes)`);
        return { run: true, tier, degraded: true };
      }
      const why = client.strictFailClosed ? "strict fail-closed" : "high-stakes";
      log(`Backend unreachable - ${toolName} (${tier}) denied (${why}, fail-safe)`);
      return {
        run: false,
        tier,
        message: blocked(
          `OKed backend unreachable. This ${tier} action is denied (${why}, fail-safe).`,
        ),
      };
    }
    log(`Unexpected error (${errorText(err)}) - action denied (fail-safe)`);
    return {
      run: false,
      tier,
      message: blocked(`OKed: unexpected error (fail-safe) for ${toolName}: ${errorText(err)}.`),
    };
  }
}
