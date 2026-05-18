import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface PersistedConfig {
  apiKey?: string;
  backendUrl?: string;
  strictFailClosed?: boolean;
}

export const OKED_CONFIG_PATH = join(homedir(), ".oked", "config.json");

/**
 * Read ~/.oked/config.json if present. Returns {} on any error (missing file,
 * malformed JSON, no home dir). Callers should treat this as a best-effort
 * lookup behind explicit arguments and environment variables.
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
    return out;
  } catch {
    return {};
  }
}
