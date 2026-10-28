import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { findClaudeOkedHooks, HOOK_TIMEOUT_SECONDS, type ClaudeHookHit } from "@oked/hook-core";

export const HOOK_COMMAND = "oked-copilot-hook";

export type InstallAction = "installed" | "updated" | "unchanged" | "skipped-claude-hook" | "unreadable";

export interface InstallResult {
  action: InstallAction;
  path: string;
  claudeHooks: ClaudeHookHit[];
}

export function hooksPath(cwd: string): string {
  return join(cwd, ".github", "hooks", "oked.json");
}

interface HookEntry {
  type?: string;
  command?: string;
  bash?: string;
  powershell?: string;
  exec?: string;
  timeoutSec?: number;
  timeout?: number;
  [key: string]: unknown;
}

const COMMAND_KEYS = ["command", "bash", "powershell", "exec"] as const;

function commandOf(hook: HookEntry): string | undefined {
  for (const key of COMMAND_KEYS) {
    if (typeof hook[key] === "string") return hook[key] as string;
  }
  return undefined;
}

function isOurs(hook: unknown): hook is HookEntry {
  return !!hook && typeof hook === "object" && commandOf(hook as HookEntry) === HOOK_COMMAND;
}

function readDoc(path: string): { doc: Record<string, unknown>; state: "absent" | "ok" | "unreadable" } {
  if (!existsSync(path)) return { doc: {}, state: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { doc: {}, state: "unreadable" };
    return { doc: parsed as Record<string, unknown>, state: "ok" };
  } catch {
    return { doc: {}, state: "unreadable" };
  }
}

function preList(doc: Record<string, unknown>): HookEntry[] {
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const pre = (hooks as { preToolUse?: unknown }).preToolUse;
  if (!Array.isArray(pre)) return [];
  return pre.filter((hook) => hook && typeof hook === "object") as HookEntry[];
}

function documentHasOurs(doc: Record<string, unknown>): boolean {
  return preList(doc).some(isOurs);
}

function raiseTimeout(hook: HookEntry): boolean {
  const current =
    typeof hook.timeoutSec === "number" ? hook.timeoutSec : typeof hook.timeout === "number" ? hook.timeout : 0;
  let changed = false;
  if (current < HOOK_TIMEOUT_SECONDS) {
    hook.timeoutSec = HOOK_TIMEOUT_SECONDS;
    changed = true;
  } else if (typeof hook.timeoutSec !== "number") {
    hook.timeoutSec = current;
    changed = true;
  }
  // `timeout` is only an alias, and `timeoutSec` wins when both are set.
  if (typeof hook.timeout === "number") {
    delete hook.timeout;
    changed = true;
  }
  return changed;
}

/**
 * Add the OKed preToolUse hook, or raise a short timeoutSec. A longer value
 * is kept. The `timeout` alias is removed so it cannot disagree with
 * timeoutSec. Other hooks stay.
 */
export function upsertCopilotHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(doc);
  const hooks = (next.hooks && typeof next.hooks === "object" ? next.hooks : {}) as Record<string, unknown>;
  const list = preList(next);
  let changed = false;
  let found = false;
  for (const hook of list) {
    if (!isOurs(hook)) continue;
    found = true;
    if (hook.type !== "command") {
      hook.type = "command";
      changed = true;
    }
    if (raiseTimeout(hook)) changed = true;
  }
  if (!found) {
    list.push({ type: "command", command: HOOK_COMMAND, timeoutSec: HOOK_TIMEOUT_SECONDS });
    changed = true;
  }
  if (next.version === undefined) {
    next.version = 1;
    changed = true;
  }
  if (!changed) return { doc, changed: false };
  hooks.preToolUse = list;
  next.hooks = hooks;
  return { doc: next, changed: true };
}

export function removeCopilotHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(doc);
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== "object" || !Array.isArray((hooks as { preToolUse?: unknown }).preToolUse)) {
    return { doc: next, changed: false };
  }
  const record = hooks as { preToolUse: unknown[] };
  const kept = record.preToolUse.filter((hook) => !isOurs(hook));
  if (kept.length === record.preToolUse.length) return { doc: next, changed: false };
  if (kept.length > 0) record.preToolUse = kept;
  else delete (hooks as { preToolUse?: unknown }).preToolUse;
  if (Object.keys(hooks as object).length === 0) delete next.hooks;
  return { doc: next, changed: true };
}

function writeDoc(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

export function copilotHookInstalled(cwd: string): boolean {
  const { doc, state } = readDoc(hooksPath(cwd));
  return state === "ok" && documentHasOurs(doc);
}

/**
 * Install the project hook. Copilot CLI and VS Code read repository
 * `.claude/settings.json` and `.claude/settings.local.json`, not the user
 * file. A project `oked-hook` plus this file would ask twice, so init skips
 * unless `native` is set. A hook that is already installed is updated in place.
 */
export function installCopilotHook(cwd: string, opts?: { native?: boolean }): InstallResult {
  const path = hooksPath(cwd);
  const claudeHooks = findClaudeOkedHooks(cwd, { includeUser: false });
  const { doc, state } = readDoc(path);
  if (state === "unreadable") return { action: "unreadable", path, claudeHooks };
  const had = documentHasOurs(doc);
  if (claudeHooks.length > 0 && !opts?.native && !had) {
    return { action: "skipped-claude-hook", path, claudeHooks };
  }
  const next = upsertCopilotHooks(doc);
  if (!next.changed) return { action: "unchanged", path, claudeHooks };
  writeDoc(path, next.doc);
  return { action: had ? "updated" : "installed", path, claudeHooks };
}

export function uninstallCopilotHook(cwd: string): { action: "removed" | "absent" | "unreadable"; path: string } {
  const path = hooksPath(cwd);
  const { doc, state } = readDoc(path);
  if (state === "absent") return { action: "absent", path };
  if (state === "unreadable") return { action: "unreadable", path };
  const next = removeCopilotHooks(doc);
  if (!next.changed) return { action: "absent", path };
  const leftover = Object.keys(next.doc).filter((key) => key !== "version");
  if (leftover.length === 0) unlinkSync(path);
  else writeDoc(path, next.doc);
  return { action: "removed", path };
}
