import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * One JSON line per hook decision that is not an allow (deny or ask), so a
 * person can see later why an action was blocked. It never holds the tool
 * input or the description: a command line can contain a secret.
 */
export const OKED_HOOK_LOG = join(homedir(), ".oked", "hook.log");

/** Above this size, hook.log moves to hook.log.1 and a new file starts. */
const MAX_BYTES = 1_000_000;

export interface ErrorInfo {
  name: string;
  message: string;
  status?: number;
}

export interface DecisionLogEntry {
  ts: string;
  decision: "deny" | "ask";
  reason: string;
  tool: string;
  tier: string | null;
  client: string;
  approval_id?: string | null;
  receipt_id?: string | null;
  error?: ErrorInfo;
}

/** Name, one-line message (at most 300 characters) and HTTP status, if any. */
export function errorInfo(err: unknown): ErrorInfo {
  const e = err as { name?: unknown; message?: unknown; status?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : typeof err;
  const raw = typeof e?.message === "string" ? e.message : String(err);
  const line = raw.replace(/\s+/g, " ").trim();
  const message = line.length > 300 ? line.slice(0, 297) + "..." : line;
  return typeof e?.status === "number" ? { name, message, status: e.status } : { name, message };
}

/** Appends one entry. Best-effort: a log problem never changes the decision. */
export function logDecision(
  entry: Omit<DecisionLogEntry, "ts">,
  path = process.env.OKED_HOOK_LOG || OKED_HOOK_LOG,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No file yet.
    }
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    // The decision itself is already written to stdout.
  }
}
