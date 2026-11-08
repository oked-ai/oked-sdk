import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface PersistedConfig {
  apiKey?: string;
  backendUrl?: string;
  strictFailClosed?: boolean;
  /** TTL (seconds) for the on-disk rules cache. See OKedConfig.rulesCacheTtlMs. */
  rulesCacheTtlSeconds?: number;
  /** Min interval (seconds) between heartbeats. See OKedConfig.heartbeatIntervalMs. */
  heartbeatIntervalSeconds?: number;
  /** Deny an approval that arrives without a receipt (default true). See OKedConfig.requireReceipt. */
  requireReceipt?: boolean;
  /** Where to fetch receipt keys. See OKedConfig.receiptKeysUrl. */
  receiptKeysUrl?: string;
}

export const OKED_CONFIG_PATH = join(homedir(), ".oked", "config.json");

/**
 * Read the saved settings file if present. Returns {} on any error (missing
 * file, malformed JSON, no home dir). Callers should treat this as a
 * best-effort lookup behind an explicit argument.
 */
export function loadOKedConfig(): PersistedConfig {
  try {
    const raw = readFileSync(OKED_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: PersistedConfig = {};
    if (typeof parsed.apiKey === "string" && parsed.apiKey) out.apiKey = parsed.apiKey;
    if (typeof parsed.backendUrl === "string" && parsed.backendUrl) out.backendUrl = parsed.backendUrl;
    if (typeof parsed.strictFailClosed === "boolean") out.strictFailClosed = parsed.strictFailClosed;
    if (typeof parsed.rulesCacheTtlSeconds === "number" && parsed.rulesCacheTtlSeconds >= 0) {
      out.rulesCacheTtlSeconds = parsed.rulesCacheTtlSeconds;
    }
    if (typeof parsed.heartbeatIntervalSeconds === "number" && parsed.heartbeatIntervalSeconds >= 0) {
      out.heartbeatIntervalSeconds = parsed.heartbeatIntervalSeconds;
    }
    if (typeof parsed.requireReceipt === "boolean") out.requireReceipt = parsed.requireReceipt;
    if (typeof parsed.receiptKeysUrl === "string" && parsed.receiptKeysUrl) out.receiptKeysUrl = parsed.receiptKeysUrl;
    return out;
  } catch {
    return {};
  }
}
