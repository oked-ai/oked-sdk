import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { parseOkedMode, type OkedMode } from "./mode.js";

export interface PersistedConfig {
  apiKey?: string;
  backendUrl?: string;
  /** `watch` records risky actions and lets them run. `enforce` pauses them. */
  mode?: OkedMode;
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

/** `~/.oked/config.json`, resolved when called so a changed home directory is honored. */
export function okedConfigPath(): string {
  return join(homedir(), ".oked", "config.json");
}

export const OKED_CONFIG_PATH = okedConfigPath();
export const OKED_RULES_CACHE_PATH = join(homedir(), ".oked", "rules-cache.json");
export const OKED_HEARTBEAT_PATH = join(homedir(), ".oked", "heartbeat.json");
export const OKED_RECEIPT_KEYS_PATH = join(homedir(), ".oked", "receipt-keys.json");

/**
 * Read ~/.oked/config.json if present. Returns {} on any error (missing file,
 * malformed JSON, no home dir). Callers should treat this as a best-effort
 * lookup behind explicit arguments and environment variables.
 */
export function loadOKedConfig(): PersistedConfig {
  try {
    const raw = readFileSync(okedConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: PersistedConfig = {};
    if (typeof parsed.apiKey === "string" && parsed.apiKey) out.apiKey = parsed.apiKey;
    if (typeof parsed.backendUrl === "string" && parsed.backendUrl) out.backendUrl = parsed.backendUrl;
    const mode = parseOkedMode(parsed.mode);
    if (mode) out.mode = mode;
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

/**
 * Set `mode` in ~/.oked/config.json without dropping other keys.
 * Best-effort permissions: directory 0700, file 0600.
 */
export function saveOkedMode(mode: OkedMode): void {
  const path = okedConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  raw.mode = mode;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not honor this mode. The file is still in the user profile.
  }
}
