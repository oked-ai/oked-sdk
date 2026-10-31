import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { loadOKedConfig } from "./config.js";
import { parseOkedMode, type OkedMode } from "./mode.js";

export type { OkedMode } from "./mode.js";
export { parseOkedMode } from "./mode.js";

/**
 * Explicit value, then OKED_MODE, then ~/.oked/config.json `mode`, then enforce.
 * Anything other than `watch` or `enforce` is ignored, so a typo keeps enforcement on.
 */
export function resolveOkedMode(explicit?: unknown, persisted?: unknown): OkedMode {
  const fromExplicit = parseOkedMode(explicit);
  if (fromExplicit) return fromExplicit;
  const fromEnv = parseOkedMode(process.env.OKED_MODE);
  if (fromEnv) return fromEnv;
  const fromArg = parseOkedMode(persisted);
  if (fromArg) return fromArg;
  if (persisted === undefined) {
    const fromFile = parseOkedMode(loadOKedConfig().mode);
    if (fromFile) return fromFile;
  }
  return "enforce";
}

/**
 * An option wins, then a client that already resolved mode, then env and the config file.
 * A client mode of `enforce` is a real choice (the default), so it is not read past.
 */
export function effectiveMode(explicit?: unknown, clientMode?: unknown): OkedMode {
  const chosen = parseOkedMode(explicit);
  if (chosen) return chosen;
  const fromClient = parseOkedMode(clientMode);
  if (fromClient) return fromClient;
  return resolveOkedMode();
}

/** Fixed phrases. The log never stores a command, a description, or tool arguments. */
export const WATCH_REASONS = [
  "would have paused",
  "would have paused (not paired)",
  "would have paused (saved rule)",
] as const;

export type WatchReason = (typeof WATCH_REASONS)[number];

export function isWatchReason(value: unknown): value is WatchReason {
  return typeof value === "string" && (WATCH_REASONS as readonly string[]).includes(value);
}

export interface WatchLogEntry {
  ts: string;
  outcome: "would_have_paused";
  tool: string;
  tier: string;
  client: string;
  source: string;
  reason: WatchReason;
}

const TIERS = new Set(["safe", "warning", "review", "high_stakes"]);
const MAX_BYTES = 1_000_000;

/** Default `~/.oked/watch.log`. `OKED_WATCH_LOG` overrides the path. */
export function watchLogPath(): string {
  const override = process.env.OKED_WATCH_LOG;
  if (typeof override === "string" && override) return override;
  return join(homedir(), ".oked", "watch.log");
}

function oneLine(value: unknown, max: number, fallback: string): string {
  const raw = typeof value === "string" ? value : "";
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line) return fallback;
  return line.length > max ? line.slice(0, max) : line;
}

/**
 * Append one "would have paused" line. Best-effort: a log problem never changes the decision.
 * The line is tool name, tier, client, source, and a fixed reason. It does not include
 * the command, tool arguments, description, working directory, session id, or API key.
 */
export function recordWouldHavePaused(entry: {
  tool: string;
  tier: string;
  client: string;
  source: string;
  reason: WatchReason;
}, path = watchLogPath()): void {
  const row: WatchLogEntry = {
    ts: new Date().toISOString(),
    outcome: "would_have_paused",
    tool: oneLine(entry.tool, 120, "unknown"),
    tier: TIERS.has(entry.tier) ? entry.tier : "unknown",
    client: oneLine(entry.client, 80, "unknown"),
    source: oneLine(entry.source, 40, "unknown"),
    reason: isWatchReason(entry.reason) ? entry.reason : "would have paused",
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No file yet.
    }
    appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch {
    // The action is already allowed. A full disk must not turn watch into a pause.
  }
}

export function readWatchLog(path = watchLogPath()): { entries: WatchLogEntry[]; unparsable: number } {
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { entries: [], unparsable: 0 };
  }
  const entries: WatchLogEntry[] = [];
  let unparsable = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<WatchLogEntry>;
      if (!parsed || parsed.outcome !== "would_have_paused" || !isWatchReason(parsed.reason)) {
        unparsable += 1;
        continue;
      }
      entries.push({
        ts: oneLine(parsed.ts, 40, ""),
        outcome: "would_have_paused",
        tool: oneLine(parsed.tool, 120, "unknown"),
        tier: oneLine(parsed.tier, 40, "unknown"),
        client: oneLine(parsed.client, 80, "unknown"),
        source: oneLine(parsed.source, 40, "unknown"),
        reason: parsed.reason,
      });
    } catch {
      unparsable += 1;
    }
  }
  return { entries, unparsable };
}

function counts(entries: WatchLogEntry[], key: (entry: WatchLogEntry) => string): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const name = key(entry);
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Text for `oked report`. States what the file holds and what was not sent. */
export function formatWatchReport(path = watchLogPath()): string {
  const { entries, unparsable } = readWatchLog(path);
  const lines: string[] = [];
  lines.push("OKed watch report");
  lines.push(`  File: ${path}`);
  lines.push(`  Would have paused: ${entries.length}`);
  if (unparsable) lines.push(`  Unreadable lines: ${unparsable}`);
  lines.push("");
  if (entries.length === 0) {
    lines.push("No actions are recorded yet.");
    lines.push("Watch mode writes a line when an action would have paused. Enforce mode, the default, does not write this file.");
  } else {
    lines.push("By tier:");
    for (const [tier, count] of counts(entries, (entry) => entry.tier)) {
      lines.push(`  ${tier}  ${count}`);
    }
    lines.push("");
    lines.push("By tool:");
    for (const [tool, count] of counts(entries, (entry) => entry.tool)) {
      lines.push(`  ${tool}  ${count}`);
    }
    lines.push("");
    lines.push("Recent:");
    for (const entry of entries.slice(-15)) {
      lines.push(`  ${entry.ts}  ${entry.tool}  ${entry.tier}  ${entry.client}  ${entry.reason}`);
    }
  }
  lines.push("");
  lines.push("Stored: time, tool name, tier, client, source, and that the action would have paused.");
  lines.push("Not stored: the command, tool arguments, description, working directory, session id, and API key.");
  lines.push("Not sent: the action. Watch mode does not call the approval API, because that call holds the action until a person decides.");
  lines.push("A presence ping may still be sent when an API key is set. That ping is the machine hostname only, and it does not include the action.");
  lines.push("A rules fetch may still run for a safe or warning action. That request does not send the action.");
  lines.push("To pause these actions, run: oked init --mode enforce");
  return lines.join("\n");
}
