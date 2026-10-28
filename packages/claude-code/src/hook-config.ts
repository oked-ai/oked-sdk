/**
 * The hook entry `oked init` writes into `.claude/settings.json`, plus the
 * in-place upgrades applied when an older entry is already there.
 *
 * Kept out of cli.ts because that module runs its command switch on import,
 * which makes it untestable. Most are pure functions over the settings shape;
 * upgradeSettingsFile() reads and writes one file.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";

export const MCP_TOOL_MATCHER = "mcp__.*";
export const DEFAULT_TOOL_MATCHER = `Bash|Write|Edit|Agent|${MCP_TOOL_MATCHER}`;

/**
 * Seconds Claude Code lets `oked-hook` run before killing it.
 *
 * Must stay ABOVE the SDK's approval timeout: on expiry the SDK aborts its
 * request and the hook writes a fail-safe deny, but a killed process writes
 * nothing at all and Claude Code falls back to its own default, so an equal
 * (or smaller) value turns the timeout path from "deny" into "gate falls
 * open". The 60s margin covers process spawn plus heartbeat() and getRules(),
 * which both run before approve() is even called.
 *
 * Claude Code imposes no ceiling of its own: the field is validated as any
 * positive number of seconds, and defaults to 600 when absent.
 * The number itself lives in `@oked/hook-core` so every host uses the same 690.
 */
export { HOOK_TIMEOUT_SECONDS };

export const HOOK_CONFIG = {
  matcher: DEFAULT_TOOL_MATCHER,
  hooks: [
    {
      type: "command",
      command: "oked-hook",
      timeout: HOOK_TIMEOUT_SECONDS,
    },
  ],
};

export function isOkedCommandHook(h: unknown): h is Record<string, unknown> {
  return (
    typeof h === "object" &&
    h !== null &&
    (h as Record<string, unknown>).command === "oked-hook"
  );
}

export function hasOkedCommandHook(entry: { hooks?: unknown[] }): boolean {
  return Boolean(entry.hooks?.some(isOkedCommandHook));
}

export function ensureMcpMatcher(matcher?: string): string | undefined {
  if (!matcher) return matcher;
  const parts = matcher.split("|").map((part) => part.trim());
  if (parts.some((part) => part === MCP_TOOL_MATCHER || part.startsWith("mcp__"))) {
    return matcher;
  }
  return `${matcher}|${MCP_TOOL_MATCHER}`;
}

/**
 * Raise a stale hook timeout in place. Installs created before the 10-minute
 * approval window carry the old 300s, and `init()` never rewrites an entry it
 * already recognizes, so without this they would keep a limit that now sits
 * BELOW the SDK's own timeout - the killed-before-deny case. Only ever raises:
 * a user who deliberately set a longer window keeps it.
 *
 * Returns true when something changed.
 */
export function ensureHookTimeout(entry: { hooks?: unknown[] }): boolean {
  let updated = false;
  for (const h of entry.hooks ?? []) {
    if (!isOkedCommandHook(h)) continue;
    const current = h.timeout;
    if (typeof current === "number" && current >= HOOK_TIMEOUT_SECONDS) continue;
    h.timeout = HOOK_TIMEOUT_SECONDS;
    updated = true;
  }
  return updated;
}

/**
 * Apply the in-place upgrades (MCP matcher, timeout) to every `oked-hook`
 * entry of a settings object. Never adds a hook. Returns true when something
 * changed.
 */
export function upgradeOkedHooks(settings: { hooks?: Record<string, unknown> }): boolean {
  const preToolUse = settings.hooks?.PreToolUse;
  if (!Array.isArray(preToolUse)) return false;
  let updated = false;
  for (const entry of preToolUse as Array<{ matcher?: string; hooks?: unknown[] }>) {
    if (!entry || typeof entry !== "object" || !hasOkedCommandHook(entry)) continue;
    const nextMatcher = ensureMcpMatcher(entry.matcher);
    if (nextMatcher !== entry.matcher) {
      entry.matcher = nextMatcher;
      updated = true;
    }
    if (ensureHookTimeout(entry)) updated = true;
  }
  return updated;
}

/** The user-level Claude Code settings file (all projects). */
export function userSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

export type SettingsFileUpgrade = "updated" | "unchanged" | "no-oked-hook" | "absent" | "unreadable";

/**
 * Upgrade the `oked-hook` entries in one settings file, in place. A file with
 * no `oked-hook` entry is left alone: this never installs the hook there.
 * A file that does not parse is never rewritten.
 */
export function upgradeSettingsFile(path: string): SettingsFileUpgrade {
  if (!existsSync(path)) return "absent";
  let settings: { hooks?: Record<string, unknown> };
  try {
    settings = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return "unreadable";
  }
  const pre = settings?.hooks?.PreToolUse;
  if (!Array.isArray(pre) || !pre.some((e) => e && typeof e === "object" && hasOkedCommandHook(e as { hooks?: unknown[] }))) {
    return "no-oked-hook";
  }
  if (!upgradeOkedHooks(settings)) return "unchanged";
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return "updated";
}
