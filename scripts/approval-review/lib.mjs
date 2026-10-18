// Shared helpers for the approval review loop (see
// docs/approval-review/RUNBOOK.md). Plain Node, no dependencies:
// the SDK is loaded from the workspace build (packages/sdk/dist), so a run
// always judges cards with the code on this branch.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CORPUS_PATH = join(REPO_ROOT, "packages/sdk/test/fixtures/approval-corpus.jsonl");
export const CHANGES_PATH = join(REPO_ROOT, "docs/approval-review/changes.jsonl");
export const LOG_PATH = join(REPO_ROOT, "docs/approval-review/LOG.md");
export const STATE_PATH = process.env.OKED_REVIEW_STATE || join(homedir(), ".oked", "review-state.json");

// The backend cuts Body to this many characters before it stores and shows a
// card (oked-app approval.controller.ts BODY_MAX). Rebuilt cards get the same
// cut, so a diff never reports the cut itself as a change.
const BODY_MAX = 200;

export const TIER_ORDER = { safe: 0, warning: 1, review: 2, high_stakes: 3 };

export async function loadSdk() {
  const dist = join(REPO_ROOT, "packages/sdk/dist/index.js");
  if (!existsSync(dist)) {
    throw new Error("packages/sdk/dist is missing. Run: npm run build --workspace=@oked/sdk");
  }
  return import(dist);
}

export function loadConfig() {
  const file = join(homedir(), ".oked", "config.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const apiKey = process.env.OKED_API_KEY || cfg.apiKey;
  const backendUrl = (process.env.OKED_BACKEND_URL || cfg.backendUrl || "https://api.oked.ai").replace(/\/$/, "");
  if (!apiKey) throw new Error("No OKed API key. Set OKED_API_KEY or run `oked init`.");
  return { apiKey, backendUrl };
}

export function readState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
}

export function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function capBody(fields) {
  if (!fields?.Body || fields.Body.length <= BODY_MAX) return fields;
  return { ...fields, Body: fields.Body.slice(0, BODY_MAX - 1).trimEnd() + "…" };
}

/** Rebuild a card with the workspace SDK, the way the backend would. */
export function rebuild(sdk, item) {
  const ctx = item.cwd ? { cwd: item.cwd } : {};
  return {
    tier: sdk.classify(item.action, item.toolInput),
    fields: capBody(sdk.describeFields(item.action, item.toolInput, ctx)),
  };
}

/**
 * A card's shape: the action plus its title with the specific parts (numbers,
 * quoted names, paths) taken out. Cards of one shape are reviewed together.
 */
export function shapeOf(item) {
  const title = (item.fields?.Title || item.action || "")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/#?\d+/g, "#")
    .replace(/(?:~|\/)[^\s]*/g, "<path>");
  return `${item.action} · ${item.fields?.Kind || "?"} · ${title}`;
}

export function sameFields(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if ((a || {})[k] !== (b || {})[k]) return false;
  return true;
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}
