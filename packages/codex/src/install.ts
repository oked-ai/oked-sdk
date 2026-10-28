import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";

export const HOOK_COMMAND = "oked-codex-hook";
/** `*` matches every tool, including ones this package does not know by name. */
export const HOOK_MATCHER = "*";

export type InstallAction = "installed" | "updated" | "unchanged" | "unreadable";

export function hooksPath(cwd: string): string {
  return join(cwd, ".codex", "hooks.json");
}

interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
  [key: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

function isOurs(hook: unknown): hook is HookHandler {
  return !!hook && typeof hook === "object" && (hook as HookHandler).command === HOOK_COMMAND;
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

function preGroups(doc: Record<string, unknown>): MatcherGroup[] {
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const pre = (hooks as { PreToolUse?: unknown }).PreToolUse;
  if (!Array.isArray(pre)) return [];
  return pre.filter((group) => group && typeof group === "object") as MatcherGroup[];
}

function documentHasOurs(doc: Record<string, unknown>): boolean {
  return preGroups(doc).some((group) => (group.hooks ?? []).some(isOurs));
}

/**
 * Add the OKed PreToolUse hook, or raise a short timeout on the one already
 * there. A longer timeout is left alone. `async` is removed: a background
 * hook does not wait for the person. Other hooks in the file stay.
 */
export function upsertCodexHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(doc);
  const hooks = (next.hooks && typeof next.hooks === "object" ? next.hooks : {}) as Record<string, unknown>;
  const groups = preGroups(next);
  let changed = false;
  let found = false;
  for (const group of groups) {
    const list = Array.isArray(group.hooks) ? group.hooks : [];
    group.hooks = list;
    for (const hook of list) {
      if (!isOurs(hook)) continue;
      found = true;
      if (hook.type !== "command") {
        hook.type = "command";
        changed = true;
      }
      if (hook.async === true) {
        delete hook.async;
        changed = true;
      }
      if (typeof hook.timeout !== "number" || hook.timeout < HOOK_TIMEOUT_SECONDS) {
        hook.timeout = HOOK_TIMEOUT_SECONDS;
        changed = true;
      }
    }
  }
  if (!found) {
    groups.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    changed = true;
  }
  if (!changed) return { doc, changed: false };
  hooks.PreToolUse = groups;
  next.hooks = hooks;
  return { doc: next, changed: true };
}

/** Remove only the OKed hook. Other hooks stay. */
export function removeCodexHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(doc);
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== "object" || !Array.isArray((hooks as { PreToolUse?: unknown }).PreToolUse)) {
    return { doc: next, changed: false };
  }
  const record = hooks as { PreToolUse: unknown[] };
  let changed = false;
  const groups: unknown[] = [];
  for (const group of record.PreToolUse) {
    if (!group || typeof group !== "object") {
      groups.push(group);
      continue;
    }
    const list = Array.isArray((group as MatcherGroup).hooks) ? (group as MatcherGroup).hooks! : [];
    const kept = list.filter((hook) => !isOurs(hook));
    if (kept.length !== list.length) changed = true;
    if (kept.length > 0) groups.push({ ...(group as MatcherGroup), hooks: kept });
    else if (list.length === 0) groups.push(group);
  }
  if (!changed) return { doc: next, changed: false };
  if (groups.length > 0) record.PreToolUse = groups;
  else delete (hooks as { PreToolUse?: unknown }).PreToolUse;
  if (Object.keys(hooks as object).length === 0) delete next.hooks;
  return { doc: next, changed: true };
}

function writeDoc(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

export function codexHookInstalled(cwd: string): boolean {
  const { doc, state } = readDoc(hooksPath(cwd));
  return state === "ok" && documentHasOurs(doc);
}

export function installCodexHook(cwd: string): { action: InstallAction; path: string } {
  const path = hooksPath(cwd);
  const { doc, state } = readDoc(path);
  if (state === "unreadable") return { action: "unreadable", path };
  const had = documentHasOurs(doc);
  const next = upsertCodexHooks(doc);
  if (!next.changed) return { action: "unchanged", path };
  writeDoc(path, next.doc);
  return { action: had ? "updated" : "installed", path };
}

export function uninstallCodexHook(cwd: string): { action: "removed" | "absent" | "unreadable"; path: string } {
  const path = hooksPath(cwd);
  const { doc, state } = readDoc(path);
  if (state === "absent") return { action: "absent", path };
  if (state === "unreadable") return { action: "unreadable", path };
  const next = removeCodexHooks(doc);
  if (!next.changed) return { action: "absent", path };
  if (Object.keys(next.doc).length === 0) unlinkSync(path);
  else writeDoc(path, next.doc);
  return { action: "removed", path };
}
