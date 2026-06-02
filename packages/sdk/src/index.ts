import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ApprovalRequest, ApprovalResponse, OKedConfig } from "./types.js";
import type { Rule } from "./rules.js";
import { loadOKedConfig, OKED_RULES_CACHE_PATH, OKED_HEARTBEAT_PATH } from "./config.js";
import { OKedAuthError, OKedBackendUnreachableError } from "./errors.js";
import { hostname } from "os";

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
      timeout: config?.timeout || 300_000,
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
    };
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
          metadata: {
            tool_input: request.tool_input,
            session_id: request.session_id,
            cwd: request.cwd,
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
      // Network failure or the request-level timeout firing (AbortError).
      // Both mean we never got a decision from the backend -> treat as an
      // outage so degraded-mode can apply.
      throw new OKedBackendUnreachableError(
        err instanceof Error ? `OKed backend unreachable: ${err.message}` : "OKed backend unreachable",
        err,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new OKedAuthError(`OKed backend error ${res.status}: ${body}`, res.status);
      }
      if (res.status >= 500) {
        throw new OKedBackendUnreachableError(`OKed backend error ${res.status}: ${body}`);
      }
      throw new Error(`OKed backend error ${res.status}: ${body}`);
    }

    const result = (await res.json()) as {
      approval_id: string;
      decision: string;
      status: string;
    };

    return {
      approved: result.decision === "approved",
      approval_id: result.approval_id,
      decision: result.decision as ApprovalResponse["decision"],
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

export { OKedAuthError, OKedBackendUnreachableError } from "./errors.js";
export { TIER_ORDER, degradedDecision } from "./degraded.js";
export { classify } from "./classify.js";
export { describe, describeFields } from "./describe.js";
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
export { loadOKedConfig, OKED_CONFIG_PATH } from "./config.js";
export type { PersistedConfig } from "./config.js";
export type {
  RiskTier,
  ApprovalRequest,
  ApprovalResponse,
  OKedConfig,
  HookInput,
  HookOutput,
} from "./types.js";
