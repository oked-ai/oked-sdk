import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OKedClient,
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
  TIER_ORDER,
  applyRules,
  classify,
  degradedDecision,
  describe,
  describeFields,
  lookupPrTitle,
  type ApprovalResponse,
  type RiskTier,
} from "@oked/sdk";
import {
  approvedMessage,
  authMessage,
  classifierMessage,
  deniedMessage,
  httpMessage,
  malformedMessage,
  missingNameMessage,
  noKeyMessage,
  pendingMessage,
  receiptMessage,
  timeoutMessage,
  unexpectedMessage,
  unreachableMessage,
} from "./messages.js";
import type { OkedAiOptions, OkedGateClient, OkedGateResult } from "./types.js";

export { unexpectedMessage } from "./messages.js";

const APPROVAL_TIERS: ReadonlySet<RiskTier> = new Set(["review", "high_stakes"]);

const CLIENT_ID = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return `@oked/ai-sdk@${JSON.parse(readFileSync(pkgPath, "utf-8")).version}`;
  } catch {
    return "@oked/ai-sdk";
  }
})();

function defaultLog(message: string): void {
  process.stderr.write(`[OKed] ${message}\n`);
}

export interface GateCall {
  toolName: string;
  input: unknown;
  toolCallId?: string;
}

function asToolInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (input === undefined) return {};
  return { value: input };
}

function resolveMinTier(options: OkedAiOptions): RiskTier {
  if (options.minTier && options.minTier in TIER_ORDER) return options.minTier;
  const env = process.env.OKED_MIN_TIER;
  if (env && env in TIER_ORDER) return env as RiskTier;
  return "review";
}

function isStrict(options: OkedAiOptions, client: OkedGateClient): boolean {
  if (typeof options.strictFailClosed === "boolean") return options.strictFailClosed;
  return client.strictFailClosed === true;
}

function resolveClient(options: OkedAiOptions): OkedGateClient {
  if (options.client) return options.client;
  const timeout =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : undefined;
  return new OKedClient({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(typeof options.strictFailClosed === "boolean"
      ? { strictFailClosed: options.strictFailClosed }
      : {}),
    client: CLIENT_ID,
    source: options.source ?? "ai-sdk",
  });
}

function deny(
  decision: "denied" | "timeout" | "error",
  approvalId: string | null,
  reason: string,
  tier: RiskTier,
): OkedGateResult {
  return { action: "deny", decision, approvalId, reason, tier };
}

function localAllow(): OkedGateResult {
  return { action: "allow", recorded: false };
}

function approvalIdOf(result: ApprovalResponse): string | null {
  return typeof result.approval_id === "string" ? result.approval_id : null;
}

function mapApproval(result: ApprovalResponse, tier: RiskTier): OkedGateResult {
  if (!result || typeof result.approved !== "boolean") {
    return deny("error", null, malformedMessage(), tier);
  }
  const approvalId = approvalIdOf(result);
  if (result.approved) {
    return { action: "allow", recorded: true, reason: approvedMessage(approvalId) };
  }
  if (result.decision === "timeout") {
    return deny("timeout", approvalId, timeoutMessage(approvalId), tier);
  }
  return deny("denied", approvalId, deniedMessage(approvalId), tier);
}

function mapError(err: unknown, tier: RiskTier, strict: boolean): OkedGateResult {
  if (err instanceof OKedReceiptError) {
    return deny("error", null, receiptMessage(err.problems), tier);
  }
  if (err instanceof OKedAuthError) {
    return deny("error", null, authMessage(), tier);
  }
  if (err instanceof OKedTooManyPendingError) {
    return deny("error", null, pendingMessage(err.message), tier);
  }
  if (err instanceof OKedHttpError) {
    return deny("error", null, httpMessage(err.status, err.detail), tier);
  }
  if (err instanceof OKedBackendUnreachableError) {
    const decision = degradedDecision(tier, { strictFailClosed: strict });
    if (decision === "allow") return localAllow();
    const why = strict ? "strict fail-closed" : "high-stakes";
    return deny("error", null, unreachableMessage(tier, why), tier);
  }
  return deny("error", null, unexpectedMessage(err), tier);
}

async function rulesWantBackend(
  client: OkedGateClient,
  tier: RiskTier,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): Promise<boolean> {
  if (!client.apiKey || !client.getRules) return false;
  try {
    const rules = await client.getRules();
    if (!Array.isArray(rules) || rules.length === 0) return false;
    const fields = describeFields(toolName, toolInput, { cwd }) ?? {};
    return Boolean(applyRules({ tier, fields }, rules, { cwd }).appliedRuleId);
  } catch {
    // A failed rules lookup must not block a safe or warning call.
    return false;
  }
}

function summaryOf(toolName: string, toolInput: Record<string, unknown>): string {
  const raw = toolInput.command ?? toolInput.cmd ?? toolInput.file_path ?? toolInput.path ?? toolName;
  return typeof raw === "string" && raw ? raw : toolName;
}

/**
 * Classify one call and, when the tier needs a person, wait on `approve()`.
 * Safe and warning calls return a local allow unless a rule matches or
 * `alwaysApprove` lists the tool. The returned denial is final: callers must
 * not run the tool.
 */
export function createGate(options: OkedAiOptions = {}): (call: GateCall) => Promise<OkedGateResult> {
  const client = resolveClient(options);
  const log = options.log ?? defaultLog;
  const cwd = options.cwd ?? process.cwd();

  return async (call) => {
    const toolName = typeof call.toolName === "string" ? call.toolName.trim() : "";
    if (!toolName) {
      return deny("error", null, missingNameMessage(), "review");
    }

    if (client.apiKey && client.heartbeat) {
      try {
        await client.heartbeat();
      } catch {
        // Presence only. A failure must not change the decision.
      }
    }

    const toolInput = asToolInput(call.input);
    const sessionId = options.sessionId || call.toolCallId || undefined;

    if (options.alwaysAllow?.includes(toolName)) {
      return localAllow();
    }

    let tier: RiskTier;
    try {
      tier = classify(toolName, toolInput);
    } catch (err) {
      log(`Classifier error on ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
      return deny("error", null, classifierMessage(), "review");
    }

    let forceAsk = false;
    if (options.alwaysApprove?.includes(toolName)) {
      if (TIER_ORDER[tier] < TIER_ORDER.review) tier = "review";
      forceAsk = true;
    }

    if (!forceAsk && (tier === "safe" || tier === "warning")) {
      const matched = await rulesWantBackend(client, tier, toolName, toolInput, cwd);
      if (!matched) {
        if (tier === "warning") {
          log(`WARNING ${toolName} ${summaryOf(toolName, toolInput)} allowed (inside project)`);
        }
        return localAllow();
      }
      forceAsk = true;
    }

    const minTier = resolveMinTier(options);
    if (!forceAsk && (TIER_ORDER[tier] < TIER_ORDER[minTier] || !APPROVAL_TIERS.has(tier))) {
      return localAllow();
    }

    if (!client.apiKey) {
      log(`No API key. Denying ${toolName}.`);
      return deny("error", null, noKeyMessage(), tier);
    }

    let fields = describeFields(toolName, toolInput, { cwd }) ?? undefined;
    const prTitle = await lookupPrTitle(fields);
    if (prTitle) fields = describeFields(toolName, toolInput, { cwd, prTitle }) ?? undefined;
    const description = describe(toolName, toolInput, prTitle ? { cwd, prTitle } : { cwd });

    log(`Requesting approval for ${toolName} (${tier}). Check Telegram or the dashboard.`);

    const strict = isStrict(options, client);
    let outcome: OkedGateResult;
    try {
      const result = await client.approve({
        action: toolName,
        description,
        tier,
        fields,
        tool_input: toolInput,
        ...(sessionId ? { session_id: sessionId } : {}),
        cwd,
      });
      outcome = mapApproval(result, tier);
    } catch (err) {
      if (err instanceof OKedBackendUnreachableError) {
        const decision = degradedDecision(tier, { strictFailClosed: strict });
        if (decision === "allow") {
          log(`Backend unreachable. ${toolName} (${tier}) allowed (degraded, non-high-stakes).`);
        }
      }
      outcome = mapError(err, tier, strict);
    }

    if (outcome.action === "allow" && outcome.recorded) {
      log(`${outcome.reason} for ${toolName}`);
    } else if (outcome.action === "deny") {
      log(`Blocking ${toolName}: ${outcome.reason}`);
    }
    return outcome;
  };
}
