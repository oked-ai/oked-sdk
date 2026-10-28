import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ClaudeHookScope = "user" | "project" | "project-local";

export interface ClaudeHookHit {
  scope: ClaudeHookScope;
  path: string;
}

/** User-level Claude Code settings. `CLAUDE_CONFIG_DIR` moves the directory. */
export function claudeUserSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

function commandIsOkedHook(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  return (
    trimmed === "oked-hook" ||
    trimmed.endsWith("/oked-hook") ||
    trimmed.endsWith("\\oked-hook")
  );
}

/** True when a Claude settings object has an `oked-hook` PreToolUse command. */
export function settingsHasOkedHook(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const pre = (settings as { hooks?: { PreToolUse?: unknown } }).hooks?.PreToolUse;
  if (!Array.isArray(pre)) return false;
  for (const entry of pre) {
    if (!entry || typeof entry !== "object") continue;
    const list = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(list)) continue;
    if (list.some((hook) => hook && typeof hook === "object" && commandIsOkedHook((hook as { command?: unknown }).command))) {
      return true;
    }
  }
  return false;
}

/**
 * Claude settings files that already install `@oked/claude-code`.
 * Cursor reads the user file and both project files. Copilot's CLI and VS
 * Code read the two project files. Pass `includeUser: false` for Copilot.
 */
export function findClaudeOkedHooks(
  cwd: string,
  opts?: { includeUser?: boolean },
): ClaudeHookHit[] {
  const candidates: ClaudeHookHit[] = [
    { scope: "project-local", path: join(cwd, ".claude", "settings.local.json") },
    { scope: "project", path: join(cwd, ".claude", "settings.json") },
  ];
  if (opts?.includeUser !== false) {
    candidates.push({ scope: "user", path: claudeUserSettingsPath() });
  }
  const hits: ClaudeHookHit[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate.path, "utf-8")) as unknown;
      if (settingsHasOkedHook(parsed)) hits.push(candidate);
    } catch {
      // A file that does not parse is not a hook we can see.
    }
  }
  return hits;
}
