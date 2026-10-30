import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ApprovalRequest, ApprovalResponse, OKedConfig } from "./types.js";
import type { Rule } from "./rules.js";
import { loadOKedConfig, OKED_RULES_CACHE_PATH, OKED_HEARTBEAT_PATH } from "./config.js";
import { OKedAuthError, OKedBackendUnreachableError, OKedHttpError, OKedTooManyPendingError } from "./errors.js";
import { randomUUID } from "crypto";
import { checkReceipt, OKED_RECEIPT_KEYS_URL } from "./receipt.js";
import { hostname } from "os";

/**
 * How long we wait for a human decision before giving up on the request.
 *
 * Sized for a human who has to be woken up (an oncall paged at 3am), not for a
 * developer watching the terminal. Integrations that run under a harness which
 * kills the hook process must set their own limit ABOVE this one, so our
 * fail-safe deny is written before the harness pulls the plug. See
 * HOOK_TIMEOUT_SECONDS in @oked/claude-code.
 *
 * 30s above the backend's own 10 minute expiry, so the backend's "timeout"
 * answer normally arrives before our abort fires (backend < SDK < harness).
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 630_000;

function envStrictFailClosed(): boolean | undefined {
  const raw = process.env.OKED_STRICT_FAIL_CLOSED;
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

function envRulesCacheTtlMs(): number | undefined {
  const raw = process.env.OKED_RULES_CACHE_TTL; // seconds
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

function envRequireReceipt(): boolean | undefined {
  const raw = process.env.OKED_REQUIRE_RECEIPT;
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

function envHeartbeatIntervalMs(): number | undefined {
  const raw = process.env.OKED_HEARTBEAT_INTERVAL; // seconds
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

interface RulesCacheEntry {
  at: number;
  rules: Rule[];
}
type RulesCacheFile = Record<string, RulesCacheEntry>;

// Small stable key so different keys/backends don't collide in the shared
// cache file, without storing the API key itself.
function rulesCacheKey(backendUrl: string, apiKey: string): string {
  const s = `${backendUrl}|${apiKey}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function readRulesCache(): RulesCacheFile {
  try {
    const parsed = JSON.parse(readFileSync(OKED_RULES_CACHE_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as RulesCacheFile) : {};
  } catch {
    return {};
  }
}

function writeRulesCache(cache: RulesCacheFile): void {
  try {
    mkdirSync(dirname(OKED_RULES_CACHE_PATH), { recursive: true });
    writeFileSync(OKED_RULES_CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Best-effort; a non-writable home dir just means no cross-call caching.
  }
}

// Last-heartbeat timestamps, keyed like the rules cache so different
// keys/backends don't collide. The Claude Code hook is a fresh process per
// call, so the throttle must live on disk.
type HeartbeatStampFile = Record<string, number>;

function readHeartbeatStamps(): HeartbeatStampFile {
  try {
    const parsed = JSON.parse(readFileSync(OKED_HEARTBEAT_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as HeartbeatStampFile) : {};
  } catch {
    return {};
  }
}

function writeHeartbeatStamps(stamps: HeartbeatStampFile): void {
  try {
    mkdirSync(dirname(OKED_HEARTBEAT_PATH), { recursive: true });
    writeFileSync(OKED_HEARTBEAT_PATH, JSON.stringify(stamps));
  } catch {
    // Best-effort; a non-writable home dir just means we re-ping next call.
  }
}

export class OKedClient {
  private config: OKedConfig;

  constructor(config?: Partial<OKedConfig>) {
    const persisted = loadOKedConfig();
    this.config = {
      apiKey: config?.apiKey || process.env.OKED_API_KEY || persisted.apiKey || "",
      backendUrl:
        config?.backendUrl ||
        process.env.OKED_BACKEND_URL ||
        persisted.backendUrl ||
        "https://api.oked.ai",
      timeout: config?.timeout || DEFAULT_APPROVAL_TIMEOUT_MS,
      // Precedence: constructor > env > ~/.oked/config.json > default false.
      strictFailClosed:
        config?.strictFailClosed ??
        envStrictFailClosed() ??
        persisted.strictFailClosed ??
        false,
      rulesCacheTtlMs:
        config?.rulesCacheTtlMs ??
        envRulesCacheTtlMs() ??
        (typeof persisted.rulesCacheTtlSeconds === "number"
          ? persisted.rulesCacheTtlSeconds * 1000
          : undefined) ??
        300_000,
      heartbeatIntervalMs:
        config?.heartbeatIntervalMs ??
        envHeartbeatIntervalMs() ??
        (typeof persisted.heartbeatIntervalSeconds === "number"
          ? persisted.heartbeatIntervalSeconds * 1000
          : undefined) ??
        86_400_000,
      // On by default from 0.6.0: an approval only counts with a valid receipt.
      // OKED_REQUIRE_RECEIPT=0 (or requireReceipt: false) for a backend that
      // does not sign receipts yet, e.g. an older self-hosted one.
      requireReceipt: config?.requireReceipt ?? envRequireReceipt() ?? persisted.requireReceipt ?? true,
      receiptKeysUrl:
        config?.receiptKeysUrl ||
        process.env.OKED_RECEIPT_KEYS_URL ||
        persisted.receiptKeysUrl ||
        OKED_RECEIPT_KEYS_URL,
      receiptKeys: config?.receiptKeys,
      client: config?.client,
      source: config?.source,
    };
  }

  get requireReceipt(): boolean {
    return this.config.requireReceipt;
  }

  get strictFailClosed(): boolean {
    return this.config.strictFailClosed;
  }

  get apiKey(): string {
    return this.config.apiKey;
  }

  get backendUrl(): string {
    return this.config.backendUrl;
  }

  async approve(request: ApprovalRequest): Promise<ApprovalResponse> {
    const signal = AbortSignal.timeout(this.config.timeout);
    // A fresh nonce per request goes into the receipt's subject, so a receipt
    // for an earlier, identical action can never be replayed for this one.
    const nonce = randomUUID();
    const source = this.config.source || "sdk";
    const doFetch = () =>
      fetch(`${this.config.backendUrl}/api/v1/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          action: request.action,
          description: request.description,
          tier: request.tier,
          fields: request.fields,
          nonce,
          client: this.config.client,
          metadata: {
            tool_input: request.tool_input,
            session_id: request.session_id,
            cwd: request.cwd,
            source: this.config.source,
          },
        }),
        signal,
      });

    let res: Response;
    try {
      try {
        res = await doFetch();
      } catch (err) {
        if (isRetriableConnectError(err)) {
          await new Promise((r) => setTimeout(r, 200));
          res = await doFetch();
        } else {
          throw err;
        }
      }
    } catch (err) {
      // The backend accepted the request and then held it past a timer: no
      // human decided in time. That is a timeout (deny), not an outage, so it
      // must never fall through to degraded-mode allow.
      if (isHeldRequestTimeout(err)) return HELD_TIMEOUT;
      // Connect failure: we never reached the backend -> treat as an outage
      // so degraded-mode can apply.
      throw new OKedBackendUnreachableError(
        err instanceof Error ? `OKed backend unreachable: ${err.message}` : "OKed backend unreachable",
        err,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = shortDetail(body);
      // A gateway that gave up waiting on a held long-poll: same as above.
      if (res.status === 504) return HELD_TIMEOUT;
      // Auth first, whatever the body: a bad key must never become an "outage",
      // or degraded mode could allow an action with an invalid key.
      if (res.status === 401 || res.status === 403) {
        throw new OKedAuthError(`OKed backend error ${res.status}: ${body}`, res.status);
      }
      if (res.status === 429) throw new OKedTooManyPendingError(errorField(body) || detail);
      // The hosting platform answered instead of the backend (the backend is
      // gone or not deployed), or something answered that is not the backend
      // at all. Both are an outage, so degraded mode applies.
      if (res.headers.get("x-railway-fallback") || /application not found/i.test(body)) {
        throw new OKedBackendUnreachableError(
          `OKed backend unreachable: HTTP ${res.status}, the hosting platform answered "application not found" (${this.config.backendUrl})`,
          undefined,
          res.status,
        );
      }
      if (!isJson(body)) {
        throw new OKedBackendUnreachableError(
          `OKed backend unreachable: HTTP ${res.status} with a reply that is not JSON${detail ? `: ${detail}` : ""}`,
          undefined,
          res.status,
        );
      }
      if (res.status >= 500) {
        throw new OKedBackendUnreachableError(`OKed backend error HTTP ${res.status}: ${detail}`, undefined, res.status);
      }
      throw new OKedHttpError(res.status, errorField(body) || detail);
    }

    let result: { approval_id: string | null; decision: string; status: string; receipt?: unknown };
    let text: string;
    try {
      // The backend sends headers at once and streams whitespace heartbeats
      // while it waits, so the wait for a human happens here, in the body.
      text = await res.text();
    } catch (err) {
      if (isHeldRequestTimeout(err)) return HELD_TIMEOUT;
      throw err;
    }
    try {
      result = JSON.parse(text) as typeof result;
      if (!result || typeof result !== "object") throw new Error("not an object");
    } catch {
      // HTTP 200 with a body that is not our JSON: not the backend. An outage.
      throw new OKedBackendUnreachableError(
        `OKed backend unreachable: HTTP ${res.status} with a reply that is not JSON` +
          ` (content-type ${res.headers.get("content-type") || "none"})`,
        undefined,
        res.status,
      );
    }

    // Nobody acts on a decision we cannot prove: an invalid receipt throws
    // OKedReceiptError (every integration denies), and so does an approval
    // with no receipt while requireReceipt is on (the default).
    const receipt = await checkReceipt(
      result,
      { action: request.action, description: request.description, toolInput: request.tool_input, source, nonce },
      {
        required: this.config.requireReceipt,
        trust: { keys: this.config.receiptKeys, keysUrl: this.config.receiptKeysUrl },
      },
    );

    return {
      approved: result.decision === "approved",
      approval_id: result.approval_id,
      decision: result.decision as ApprovalResponse["decision"],
      ...(receipt ? { receipt } : {}),
    };
  }

  /**
   * User rules for local escalation checks, cached on disk (TTL
   * `rulesCacheTtlMs`, default 5 min). The Claude Code hook is a fresh
   * process per call, so caching must be on disk. Never throws: a failed
   * fetch falls back to the last cached value (even if stale), else `[]`.
   */
  async getRules(): Promise<Rule[]> {
    if (!this.config.apiKey) return [];
    const key = rulesCacheKey(this.config.backendUrl, this.config.apiKey);
    const cache = readRulesCache();
    const entry = cache[key];
    if (entry && Date.now() - entry.at < this.config.rulesCacheTtlMs) {
      return entry.rules;
    }
    try {
      const res = await fetch(`${this.config.backendUrl}/api/v1/rules`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return entry?.rules ?? [];
      const rules = (await res.json()) as Rule[];
      if (!Array.isArray(rules)) return entry?.rules ?? [];
      writeRulesCache({ ...cache, [key]: { at: Date.now(), rules } });
      return rules;
    } catch {
      return entry?.rules ?? [];
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.backendUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Presence ping so the backend knows this install is still alive — feeds
   * retention analytics, including users who only ever run safe/warning
   * actions (which otherwise never reach the backend). Throttled on disk to
   * `heartbeatIntervalMs` (default once/day), keyed per backend+key. Never
   * throws: a missing key, a throttled call, or a failed request are all
   * silent no-ops, so it is safe to await on the hook's hot path. The stamp is
   * only advanced on a successful send, so a transient outage just re-pings
   * next call.
   */
  async heartbeat(): Promise<void> {
    if (!this.config.apiKey) return;
    const key = rulesCacheKey(this.config.backendUrl, this.config.apiKey);
    const stamps = readHeartbeatStamps();
    const last = stamps[key];
    if (typeof last === "number" && Date.now() - last < this.config.heartbeatIntervalMs) {
      return;
    }
    try {
      const res = await fetch(`${this.config.backendUrl}/api/v1/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ hostname: hostname() }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        writeHeartbeatStamps({ ...stamps, [key]: Date.now() });
      }
    } catch {
      // Best-effort presence signal; never block or break the agent.
    }
  }
}

const HELD_TIMEOUT: ApprovalResponse = { approved: false, approval_id: null, decision: "timeout" };

/**
 * True when a request reached the backend and then sat past a timer: our own
 * abort (TimeoutError), or undici's 300s headers/body timeouts, which fire
 * regardless of the abort signal on a silent long-poll.
 */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** One line, at most 200 characters: for error messages, never a whole page. */
function shortDetail(body: string): string {
  const line = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 200 ? line.slice(0, 197) + "..." : line;
}

/** The backend's own error text ({"error": "..."} or {"message": "..."}), if any. */
function errorField(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const v = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
    return shortDetail(v);
  } catch {
    return "";
  }
}

function isHeldRequestTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // AbortSignal.timeout() rejects with a DOMException, which is not an Error
  // instance on every Node version, so match on the name alone.
  if ((err as { name?: string }).name === "TimeoutError") return true;
  const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}

function isRetriableConnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

export {
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
} from "./errors.js";
export { checkReceipt, keysFor, keysUrlAllowed, OKED_RECEIPT_KEYS_URL } from "./receipt.js";
export { PINNED_RECEIPT_KEYS } from "./receipt-keys.js";
export {
  verifyReceipt,
  verifyChain,
  shortReceiptId,
  type SignedReceipt,
  type ReceiptBody,
  type ReceiptKey,
} from "@oked/receipt-core";
export { TIER_ORDER, degradedDecision } from "./degraded.js";
export { classify, splitTopLevel, type ClassifyOptions } from "./classify.js";
export { describe, describeFields, OPAQUE_RUNNER_FOOTNOTE } from "./describe.js";
export type { DescribeContext } from "./describe.js";
export { lookupPrTitle } from "./pr-title.js";
export { applyRules } from "./rules.js";
export type {
  Rule,
  RuleMatch,
  RuleAction,
  RuleDecision,
  FieldOp,
} from "./rules.js";
export type { Rendered } from "./describe.js";
export { CLASSIFIER_VERSION } from "./kinds.js";
export type { OperationKind } from "./kinds.js";
export { loadOKedConfig, OKED_CONFIG_PATH, OKED_RECEIPT_KEYS_PATH } from "./config.js";
export type { PersistedConfig } from "./config.js";
export type {
  RiskTier,
  ApprovalRequest,
  ApprovalResponse,
  OKedConfig,
  HookInput,
  HookOutput,
} from "./types.js";
