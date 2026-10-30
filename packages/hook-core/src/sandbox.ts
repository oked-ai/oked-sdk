import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { splitTopLevel } from "@oked/sdk";
import { claudeUserSettingsPath } from "./claude-hooks.js";

/**
 * Printed by `oked init` when Claude Code's Bash sandbox is not containing
 * child processes. The approval card uses the same idea as a footnote.
 */
export const SANDBOX_INIT_HINT = [
  "Test commands and scripts (cargo test, npm test, npm run, pytest, ./script.sh)",
  "ask for approval, because OKed cannot see what they run. To skip those prompts,",
  "turn on Claude Code's Bash sandbox and set allowUnsandboxedCommands to false:",
  '{ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false } }',
  "Put that in ~/.claude/settings.json or .claude/settings.local.json.",
].join("\n");

interface SandboxFile {
  enabled?: boolean;
  allowUnsandboxedCommands?: boolean;
  filesystemDisabled?: boolean;
  excludedCommands: string[];
}

export interface ClaudeSandboxView {
  enabled: boolean;
  /** Effective value. Claude's default is true when no file sets it. */
  allowUnsandboxedCommands: boolean;
  filesystemDisabled: boolean;
  excludedCommands: string[];
}

/**
 * True when the Claude Code settings this hook can see contain Bash child
 * processes in the working directory.
 *
 * Containment requires `sandbox.enabled` and `allowUnsandboxedCommands: false`.
 * A `false` in `~/.claude/settings.json` holds against a project `true`, matching
 * Claude Code. `sandbox.filesystem.disabled: true` is read only from user
 * settings (project files cannot turn filesystem isolation off). A command is
 * not contained when `sandbox.excludedCommands` covers every part of it.
 *
 * Files, highest precedence first for ordinary booleans: `.claude/settings.local.json`,
 * `.claude/settings.json`, then the user file (`CLAUDE_CONFIG_DIR` or `~/.claude`).
 * Managed settings and `--settings` are not on disk here. Missing them can only
 * add a prompt, because a sandbox we cannot see stays "not enforced".
 */
export function claudeSandboxEnforced(cwd: string, command?: string): boolean {
  const view = readClaudeSandbox(cwd);
  if (!view.enabled || view.allowUnsandboxedCommands || view.filesystemDisabled) return false;
  if (command && exclusionCoversCommand(command, view.excludedCommands)) return false;
  return true;
}

export function readClaudeSandbox(cwd: string): ClaudeSandboxView {
  const local = readSandboxFile(join(cwd, ".claude", "settings.local.json"));
  const project = readSandboxFile(join(cwd, ".claude", "settings.json"));
  const user = readSandboxFile(claudeUserSettingsPath());
  const excludedCommands = [
    ...(local?.excludedCommands ?? []),
    ...(project?.excludedCommands ?? []),
    ...(user?.excludedCommands ?? []),
  ];
  return {
    enabled: firstBoolean(local?.enabled, project?.enabled, user?.enabled) ?? false,
    allowUnsandboxedCommands: effectiveAllowUnsandboxed(
      user?.allowUnsandboxedCommands,
      project?.allowUnsandboxedCommands,
      local?.allowUnsandboxedCommands,
    ),
    filesystemDisabled: user?.filesystemDisabled === true,
    excludedCommands,
  };
}

function firstBoolean(...values: Array<boolean | undefined>): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * User `false` holds against a project or local `true`. Otherwise the highest
 * file that sets the key wins. Unset means Claude's default, true.
 */
function effectiveAllowUnsandboxed(user?: boolean, project?: boolean, local?: boolean): boolean {
  const userFalse = user === false;
  if (typeof local === "boolean") {
    if (local === true && userFalse) return false;
    return local;
  }
  if (typeof project === "boolean") {
    if (project === true && userFalse) return false;
    return project;
  }
  if (typeof user === "boolean") return user;
  return true;
}

function readSandboxFile(path: string): SandboxFile | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const sandbox = (parsed as { sandbox?: unknown }).sandbox;
  if (!sandbox || typeof sandbox !== "object") return { excludedCommands: [] };
  const record = sandbox as Record<string, unknown>;
  const filesystem = record.filesystem;
  const filesystemDisabled =
    Boolean(filesystem) &&
    typeof filesystem === "object" &&
    (filesystem as { disabled?: unknown }).disabled === true;
  const excludedCommands = Array.isArray(record.excludedCommands)
    ? record.excludedCommands.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    allowUnsandboxedCommands:
      typeof record.allowUnsandboxedCommands === "boolean" ? record.allowUnsandboxedCommands : undefined,
    filesystemDisabled: filesystemDisabled || undefined,
    excludedCommands,
  };
}

/**
 * Claude takes a Bash call out of the sandbox only when an excludedCommands
 * entry covers every command in it. `docker *` does not cover `cargo test`,
 * and it does not cover `cd x && cargo test` either.
 */
export function exclusionCoversCommand(command: string, patterns: string[]): boolean {
  const usable = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (usable.length === 0) return false;
  const stages = splitTopLevel(command);
  if (stages.length === 0) return false;
  return stages.every((stage) => usable.some((pattern) => globMatch(stage.trim(), pattern)));
}

function globMatch(text: string, pattern: string): boolean {
  if (!pattern.includes("*")) return text === pattern;
  const body = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${body}$`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
