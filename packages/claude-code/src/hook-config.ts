/**
 * The hook entry `oked init` writes into `.claude/settings.json`, plus the
 * in-place upgrades applied when an older entry is already there.
 *
 * Kept out of cli.ts because that module runs its command switch on import,
 * which makes it untestable. These are pure functions over the settings shape.
 */
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "@oked/sdk";

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
 */
export const HOOK_TIMEOUT_SECONDS = DEFAULT_APPROVAL_TIMEOUT_MS / 1000 + 60;

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
