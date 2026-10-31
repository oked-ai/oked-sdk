import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";

export type ClaudeHookScope = "user" | "project" | "project-local";

export interface ClaudeHookHit {
  scope: ClaudeHookScope;
  path: string;
}

export interface ClaudeOkedCommand {
  scope: ClaudeHookScope;
  path: string;
  /** Omitted matcher matches every tool, same as Claude Code. */
  matcher?: string;
  command: string;
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

function settingsCandidates(cwd: string, includeUser: boolean): ClaudeHookHit[] {
  const candidates: ClaudeHookHit[] = [
    { scope: "project-local", path: join(cwd, ".claude", "settings.local.json") },
    { scope: "project", path: join(cwd, ".claude", "settings.json") },
  ];
  if (includeUser) candidates.push({ scope: "user", path: claudeUserSettingsPath() });
  return candidates;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
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
  const hits: ClaudeHookHit[] = [];
  for (const candidate of settingsCandidates(cwd, opts?.includeUser !== false)) {
    if (!existsSync(candidate.path)) continue;
    if (settingsHasOkedHook(readJson(candidate.path))) hits.push(candidate);
  }
  return hits;
}

/** Every `oked-hook` PreToolUse command, including its matcher. */
export function listClaudeOkedCommands(
  cwd: string,
  opts?: { includeUser?: boolean },
): ClaudeOkedCommand[] {
  const commands: ClaudeOkedCommand[] = [];
  for (const candidate of settingsCandidates(cwd, opts?.includeUser !== false)) {
    if (!existsSync(candidate.path)) continue;
    const settings = readJson(candidate.path);
    if (!settings || typeof settings !== "object") continue;
    const pre = (settings as { hooks?: { PreToolUse?: unknown } }).hooks?.PreToolUse;
    if (!Array.isArray(pre)) continue;
    for (const entry of pre) {
      if (!entry || typeof entry !== "object") continue;
      const matcher = (entry as { matcher?: unknown }).matcher;
      const list = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(list)) continue;
      for (const hook of list) {
        if (!hook || typeof hook !== "object") continue;
        const command = (hook as { command?: unknown }).command;
        if (!commandIsOkedHook(command)) continue;
        commands.push({
          scope: candidate.scope,
          path: candidate.path,
          ...(typeof matcher === "string" ? { matcher } : {}),
          command: (command as string).trim(),
        });
      }
    }
  }
  return commands;
}

/**
 * Claude Code matchers are regular expressions. An omitted matcher matches
 * every tool. A matcher that does not compile does not match, so the other
 * gate stays responsible.
 */
export function matcherCoversTool(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

/** True when `command` is an existing file, or a name on `PATH`. */
export function commandIsResolvable(command: string, pathEnv = process.env.PATH ?? ""): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return existsSync(trimmed);
  const names =
    process.platform === "win32"
      ? [trimmed, `${trimmed}.cmd`, `${trimmed}.exe`, `${trimmed}.bat`]
      : [trimmed];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}
