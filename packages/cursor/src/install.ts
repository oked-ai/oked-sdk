import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { findClaudeOkedHooks, HOOK_TIMEOUT_SECONDS, type ClaudeHookHit } from "@oked/hook-core";

export const HOOK_COMMAND = "oked-cursor-hook";

export type InstallAction = "installed" | "updated" | "unchanged" | "skipped-claude-hook" | "unreadable";

export interface InstallResult {
  action: InstallAction;
  path: string;
  claudeHooks: ClaudeHookHit[];
}

export function hooksPath(cwd: string): string {
  return join(cwd, ".cursor", "hooks.json");
}

interface HookEntry {
  command?: string;
  timeout?: number;
  failClosed?: boolean;
  [key: string]: unknown;
}

function isOurs(hook: unknown): hook is HookEntry {
  return !!hook && typeof hook === "object" && (hook as HookEntry).command === HOOK_COMMAND;
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

/**
 * Add the OKed preToolUse hook, or raise a short timeout and set failClosed.
 * A longer timeout is left alone. Other hooks stay.
 */
export function upsertCursorHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(doc);
  const hooks = (next.hooks && typeof next.hooks === "object" ? next.hooks : {}) as Record<string, unknown>;
  const list = preList(next);
  let changed = false;
  let found = false;
  for (const hook of list) {
    if (!isOurs(hook)) continue;
    found = true;
    if (typeof hook.timeout !== "number" || hook.timeout < HOOK_TIMEOUT_SECONDS) {
      hook.timeout = HOOK_TIMEOUT_SECONDS;
      changed = true;
    }
    if (hook.failClosed !== true) {
      hook.failClosed = true;
      changed = true;
    }
  }
  if (!found) {
    list.push({ command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS, failClosed: true });
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

export function removeCursorHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; changed: boolean } {
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

export function cursorHookInstalled(cwd: string): boolean {
  const { doc, state } = readDoc(hooksPath(cwd));
  return state === "ok" && documentHasOurs(doc);
}

/**
 * Install the project hook. If Cursor would also run an `@oked/claude-code`
 * hook (user or project Claude settings), skip unless `native` is set.
 * A hook that is already installed is updated in place either way.
 */
export function installCursorHook(cwd: string, opts?: { native?: boolean }): InstallResult {
  const path = hooksPath(cwd);
  const claudeHooks = findClaudeOkedHooks(cwd, { includeUser: true });
  const { doc, state } = readDoc(path);
  if (state === "unreadable") return { action: "unreadable", path, claudeHooks };
  const had = documentHasOurs(doc);
  if (claudeHooks.length > 0 && !opts?.native && !had) {
    return { action: "skipped-claude-hook", path, claudeHooks };
  }
  const next = upsertCursorHooks(doc);
  if (!next.changed) return { action: "unchanged", path, claudeHooks };
  writeDoc(path, next.doc);
  return { action: had ? "updated" : "installed", path, claudeHooks };
}

export function uninstallCursorHook(cwd: string): { action: "removed" | "absent" | "unreadable"; path: string } {
  const path = hooksPath(cwd);
  const { doc, state } = readDoc(path);
  if (state === "absent") return { action: "absent", path };
  if (state === "unreadable") return { action: "unreadable", path };
  const next = removeCursorHooks(doc);
  if (!next.changed) return { action: "absent", path };
  const leftover = Object.keys(next.doc).filter((key) => key !== "version");
  if (leftover.length === 0) unlinkSync(path);
  else writeDoc(path, next.doc);
  return { action: "removed", path };
}
