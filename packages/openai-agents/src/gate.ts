/**
 * Decide whether one tool call may run.
 *
 * Safe and warning calls return without a prompt, unless a cached user rule
 * matches (then the backend decides). review and high_stakes wait on
 * approve(). An explicit denial, a timeout, a bad receipt, a bad key, and
 * any unexpected error stop the tool. An unreachable backend follows
 * degradedDecision: high_stakes denies, lower tiers allow unless
 * strictFailClosed is set.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OKedClient,
  applyRules,
  classify,
  describe,
  describeFields,
  degradedDecision,
  lookupPrTitle,
  TIER_ORDER,
  DEFAULT_APPROVAL_TIMEOUT_MS,
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
import {
  authMessage,
  deniedMessage,
  errorText,
  receiptMessage,
  timeoutMessage,
  unexpectedMessage,
  unpairedMessage,
  unreachableMessage,
  type OkedDenial,
} from "./messages.js";

const CLIENT_ID = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return `@oked/openai-agents@${JSON.parse(readFileSync(pkgPath, "utf-8")).version}`;
  } catch {
    return "@oked/openai-agents";
  }
})();

const SOURCE = "openai-agents";

/** Lowest tool timeoutMs we keep when the caller set one: the approval wait plus 60 seconds. */
export const OKED_TOOL_TIMEOUT_FLOOR_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 60_000;

const APPROVAL_TIERS: ReadonlySet<RiskTier> = new Set(["review", "high_stakes"]);

export interface OkedAgentsConfig {
  /** OKed API key. Default: OKED_API_KEY, then ~/.oked/config.json. */
  apiKey?: string;
  /**
   * How long to wait for a person, in milliseconds.
   * Default 630000 (10.5 minutes), so the backend's 10 minute expiry answers first.
   */
  timeoutMs?: number;
  /**
   * When true, an unreachable approval service denies every sensitive call.
   * When false (default), it denies high_stakes only. Env OKED_STRICT_FAIL_CLOSED.
   */
  strictFailClosed?: boolean;
  /**
   * Lowest tier that asks for a person. Default "review".
   * warning never blocks on its own. Env OKED_MIN_TIER is the fallback.
   */
  minTier?: RiskTier;
  /**
   * `watch` lets a risky call run and records that it would have paused.
   * `enforce` (default) waits. Env OKED_MODE, then ~/.oked/config.json.
   */
  mode?: OkedMode;
  /** Tool names that are always high_stakes, whatever the classifier says. */
  alwaysApprove?: readonly string[];
  /** Tool names that are always safe. Use sparingly. Skips rules and approval. */
  alwaysAllow?: readonly string[];
  /** Working directory recorded on the approval. Default process.cwd(). */
  cwd?: string;
  /**
   * Session id recorded on the approval. A function receives the Agents SDK
   * run context. When omitted, context.sessionId or context.session_id is used.
   */
  sessionId?: string | ((runContext: unknown) => string | undefined);
  /**
   * Structured value returned to the model when a tool declares an output
   * schema. Without this, a denial throws OkedToolDeniedError instead of
   * inventing a schema-shaped success.
   */
  deniedOutput?: (denial: OkedDenial) => unknown;
  /** Replace stderr logging. */
  log?: (message: string) => void;
  /**
   * Replace OKedClient.approve. Intended for tests. Production leaves this
   * unset and uses the API key. Rules lookup is skipped unless getRules is set.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /** Replace the rules fetch. Used when a test, or a caller, already has rules. */
  getRules?: () => Promise<Rule[]>;
}

export type GateResult = { proceed: true; tier: RiskTier } | { proceed: false; denial: OkedDenial };

export interface GateDeps {
  apiKey: string;
  strictFailClosed: boolean;
  skipRules: boolean;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  getRules: () => Promise<Rule[]>;
  heartbeat: () => Promise<void>;
  /** True when approve() was injected, so we do not touch the network ourselves. */
  injected: boolean;
}

function defaultLog(message: string): void {
  process.stderr.write(`[OKed] ${message}\n`);
}

function positiveMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function toolTimeoutFloor(config?: OkedAgentsConfig): number {
  return (positiveMs(config?.timeoutMs) ?? DEFAULT_APPROVAL_TIMEOUT_MS) + 60_000;
}

export function createDeps(config: OkedAgentsConfig = {}): GateDeps {
  if (config.approve) {
    return {
      apiKey: config.apiKey ?? "injected",
      strictFailClosed: config.strictFailClosed ?? false,
      skipRules: !config.getRules,
      approve: config.approve,
      getRules: config.getRules ?? (async () => []),
      heartbeat: async () => {},
      injected: true,
    };
  }

  const timeout = positiveMs(config.timeoutMs);
  const client = new OKedClient({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(timeout ? { timeout } : {}),
    ...(config.strictFailClosed !== undefined ? { strictFailClosed: config.strictFailClosed } : {}),
    client: CLIENT_ID,
    source: SOURCE,
    ...(config.mode ? { mode: config.mode } : {}),
  });
  return {
    apiKey: client.apiKey,
    strictFailClosed: config.strictFailClosed ?? client.strictFailClosed,
    skipRules: false,
    approve: (request) => client.approve(request),
    getRules: config.getRules ?? (() => client.getRules()),
    heartbeat: () => client.heartbeat(),
    injected: false,
  };
}

function cwdOf(config: OkedAgentsConfig): string {
  return config.cwd ?? process.cwd();
}

function sessionOf(config: OkedAgentsConfig, runContext: unknown): string | undefined {
  if (typeof config.sessionId === "function") {
    const value = config.sessionId(runContext);
    return typeof value === "string" && value ? value : undefined;
  }
  if (typeof config.sessionId === "string" && config.sessionId) return config.sessionId;
  if (!runContext || typeof runContext !== "object" || !("context" in runContext)) return undefined;
  const ctx = (runContext as { context?: unknown }).context;
  if (!ctx || typeof ctx !== "object") return undefined;
  const record = ctx as Record<string, unknown>;
  if (typeof record.sessionId === "string" && record.sessionId) return record.sessionId;
  if (typeof record.session_id === "string" && record.session_id) return record.session_id;
  return undefined;
}

function resolveMinTier(config: OkedAgentsConfig): RiskTier {
  const fromEnv = process.env.OKED_MIN_TIER;
  const raw = config.minTier ?? (fromEnv && fromEnv in TIER_ORDER ? (fromEnv as RiskTier) : "review");
  return raw in TIER_ORDER ? raw : "review";
}

function tierNeedsPerson(tier: RiskTier, config: OkedAgentsConfig): boolean {
  if (!APPROVAL_TIERS.has(tier)) return false;
  return TIER_ORDER[tier] >= TIER_ORDER[resolveMinTier(config)];
}

function classifyCall(toolName: string, args: Record<string, unknown>, config: OkedAgentsConfig): RiskTier {
  if (config.alwaysApprove?.includes(toolName)) return "high_stakes";
  return classify(toolName, args);
}

function denial(
  toolName: string,
  tier: RiskTier,
  decision: OkedDenial["decision"],
  approvalId: string | null,
  message: string,
): GateResult {
  return { proceed: false, denial: { toolName, tier, decision, approvalId, message } };
}

async function ruleMatches(
  toolName: string,
  args: Record<string, unknown>,
  tier: RiskTier,
  config: OkedAgentsConfig,
  deps: GateDeps,
): Promise<boolean> {
  if (!deps.apiKey || deps.skipRules) return false;
  let rules: Rule[];
  try {
    rules = await deps.getRules();
  } catch {
    return false;
  }
  if (!rules.length) return false;
  try {
    const fields = describeFields(toolName, args, { cwd: cwdOf(config) }) ?? {};
    const ruled = applyRules({ tier, fields }, rules, { cwd: cwdOf(config) });
    return Boolean(ruled.appliedRuleId);
  } catch {
    return false;
  }
}

/**
 * Classify one call and, when a person is required, wait for approve().
 * Does not run the tool. Callers turn `proceed: false` into a model-visible
 * result and must not execute the underlying function.
 */
export async function decideToolCall(
  toolName: string,
  args: Record<string, unknown>,
  config: OkedAgentsConfig,
  deps: GateDeps,
  runContext?: unknown,
): Promise<GateResult> {
  const log = config.log ?? defaultLog;

  if (!deps.injected && deps.apiKey) {
    void deps.heartbeat().catch(() => {});
  }

  if (config.alwaysAllow?.includes(toolName)) {
    return { proceed: true, tier: "safe" };
  }

  let tier: RiskTier;
  try {
    tier = classifyCall(toolName, args, config);
  } catch (err) {
    log(`classifier error on ${toolName}: ${errorText(err)}`);
    return denial(
      toolName,
      "review",
      "error",
      null,
      unexpectedMessage(toolName, `classifier: ${errorText(err)}`),
    );
  }

  let fromRule = false;
  if (tier === "safe" || tier === "warning") {
    const escalated = await ruleMatches(toolName, args, tier, config, deps);
    if (!escalated) {
      if (tier === "warning") {
        const summary = args.file_path ?? args.path ?? args.command ?? toolName;
        log(`WARNING ${toolName} ${String(summary)} - allowed`);
      }
      return { proceed: true, tier };
    }
    fromRule = true;
  } else if (!tierNeedsPerson(tier, config)) {
    return { proceed: true, tier };
  }

  if (effectiveMode(config.mode) === "watch") {
    const reason: WatchReason = !deps.apiKey
      ? "would have paused (not paired)"
      : fromRule
        ? "would have paused (saved rule)"
        : "would have paused";
    recordWouldHavePaused({
      tool: toolName,
      tier,
      client: CLIENT_ID,
      source: SOURCE,
      reason,
    });
    log(`watch: ${toolName} (${tier}) ${reason}. Allowed.`);
    return { proceed: true, tier };
  }

  if (!deps.apiKey) {
    log(`no API key - denying ${toolName}`);
    return denial(toolName, tier, "error", null, unpairedMessage(toolName));
  }

  const cwd = cwdOf(config);
  let description = toolName;
  let fields: Record<string, string> | undefined;
  try {
    fields = describeFields(toolName, args, { cwd }) ?? undefined;
    const prTitle = await lookupPrTitle(fields);
    if (prTitle) fields = describeFields(toolName, args, { cwd, prTitle }) ?? undefined;
    description = describe(toolName, args, { cwd, prTitle }) || toolName;
  } catch (err) {
    log(`could not describe ${toolName}: ${errorText(err)}`);
    return denial(toolName, tier, "error", null, unexpectedMessage(toolName, errorText(err)));
  }

  log(`${toolName}: "${description}" - ${tier}`);
  log("Requesting approval. Check Telegram or the web dashboard.");

  try {
    const result = await deps.approve({
      action: toolName,
      description,
      tier,
      fields,
      tool_input: args,
      session_id: sessionOf(config, runContext),
      cwd,
    });
    if (result.approved) {
      log(`Approved (${result.approval_id ?? "no id"})`);
      return { proceed: true, tier };
    }
    if (result.decision === "timeout") {
      log(`No decision in time (${result.approval_id ?? "no id"})`);
      return denial(toolName, tier, "timeout", result.approval_id, timeoutMessage(toolName, description, result.approval_id));
    }
    log(`Denied (${result.approval_id ?? "no id"})`);
    return denial(toolName, tier, "denied", result.approval_id, deniedMessage(toolName, description, result.approval_id));
  } catch (err) {
    if (err instanceof OKedReceiptError) {
      log(`receipt for ${toolName} did not verify: ${err.problems.join(", ")}`);
      return denial(toolName, tier, "error", null, receiptMessage(toolName, err.problems));
    }
    if (err instanceof OKedAuthError) {
      log(`invalid API key for ${toolName}`);
      return denial(toolName, tier, "error", null, authMessage(toolName));
    }
    if (err instanceof OKedTooManyPendingError) {
      log(`too many pending approvals - denying ${toolName}`);
      return denial(
        toolName,
        tier,
        "error",
        null,
        `${err.message} The tool did not run. Do not run this action until those approvals are decided.`,
      );
    }
    if (err instanceof OKedHttpError) {
      log(`backend HTTP ${err.status} - denying ${toolName}`);
      return denial(toolName, tier, "error", null, unexpectedMessage(toolName, err.message));
    }
    if (err instanceof OKedBackendUnreachableError) {
      const outcome = degradedDecision(tier, { strictFailClosed: deps.strictFailClosed });
      if (outcome === "allow") {
        log(`approval service unreachable - ${toolName} (${tier}) allowed (degraded)`);
        return { proceed: true, tier };
      }
      const why = deps.strictFailClosed ? "strict fail closed" : "high_stakes";
      log(`approval service unreachable - denying ${toolName} (${why})`);
      return denial(toolName, tier, "error", null, unreachableMessage(toolName, tier, why, errorText(err)));
    }
    log(`unexpected error for ${toolName}: ${errorText(err)}`);
    return denial(toolName, tier, "error", null, unexpectedMessage(toolName, errorText(err)));
  }
}
