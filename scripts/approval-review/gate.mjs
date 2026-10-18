#!/usr/bin/env node
// The hard gate of the approval review loop. A run may merge and release on
// its own only when this exits 0. Otherwise the PR stays open for a person.
//
//   node scripts/approval-review/gate.mjs [--base origin/main] [--fetched <fetched.json>] [--skip-tests]
//   node scripts/approval-review/gate.mjs --backend <oked-app checkout> [--base origin/main]
//
// It blocks when:
//   - a file outside the allowed list changed (this file and RUNBOOK.md included),
//   - a tier goes down from high_stakes,
//   - a tier goes down for an outward or destructive kind,
//   - more than MAX_TIER_SHAPES card shapes change tier,
//   - the corpus or the change record holds a secret or personal data,
//   - a test fails.
// Text-only changes and tier increases pass.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, CORPUS_PATH, CHANGES_PATH, LOG_PATH, TIER_ORDER, loadSdk, rebuild, shapeOf, parseArgs } from "./lib.mjs";
import { scan } from "./sanitize.mjs";

const MAX_TIER_SHAPES = 5;

// What a run may change and still ship alone.
const SDK_ALLOWED = [
  /^packages\/sdk\/src\/(classify|describe|kinds)\.ts$/,
  /^packages\/sdk\/test\//,
  /^docs\/approval-review\/(changes\.jsonl|LOG\.md)$/,
];
// The Telegram card only. The @oked/sdk pin is bumped by the release itself.
const BACKEND_ALLOWED = [
  /^backend\/src\/telegram\/telegram\.service\.ts$/,
  /^backend\/test\/telegram-render\.test\.ts$/,
];

const OUTWARD_OR_DESTRUCTIVE =
  /^(http_|email_|payment_|sql_(drop|truncate|delete))|_delete$|^(git_push|git_force_push|git_pr_merge|git_reset_hard|git_clean|npm_publish|npm_unpublish|npx_deploy|chat_message|mcp_send|mcp_post|mcp_publish|mcp_submit_form|ssh_remote|docker_rm|docker_rmi|docker_prune|docker_down|kill_process|http_pipe_to_shell|gh_write|git_pr_write)$/;

const args = parseArgs(process.argv.slice(2));
const base = args.base || "origin/main";
const reasons = [];

function changedFiles(cwd) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd, encoding: "utf8" });
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (dirty.trim()) reasons.push("the working tree has uncommitted changes; commit them first");
  return out.split("\n").filter(Boolean);
}

function checkFiles(cwd, allowed) {
  for (const f of changedFiles(cwd)) {
    if (!allowed.some((re) => re.test(f))) reasons.push(`changed a file a run may not ship alone: ${f}`);
  }
}

if (args.backend) {
  checkFiles(args.backend, BACKEND_ALLOWED);
  if (!args["skip-tests"]) {
    try {
      execFileSync("npx", ["tsx", "--test", "test/telegram-render.test.ts"], { cwd: join(args.backend, "backend"), stdio: "pipe" });
    } catch {
      reasons.push("backend test/telegram-render.test.ts fails");
    }
  }
  finish();
}

checkFiles(REPO_ROOT, SDK_ALLOWED);

// Tier moves: pinned corpus cards whose expected tier was edited, and real
// cards from this run rebuilt with this branch's SDK.
const moves = [];
const baseCorpus = (() => {
  try {
    return execFileSync("git", ["show", `${base}:packages/sdk/test/fixtures/approval-corpus.jsonl`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
})();
const nowCorpus = readFileSync(CORPUS_PATH, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
for (const old of baseCorpus) {
  const cur = nowCorpus.find((c) => c.id === old.id);
  if (!cur) {
    reasons.push(`a pinned corpus card was removed: ${old.id}`);
    continue;
  }
  if (cur.tier !== old.tier) {
    moves.push({ shape: `corpus ${old.id}`, from: old.tier, to: cur.tier, kinds: [old.fields?.Kind, cur.fields?.Kind] });
  }
}

if (args.fetched) {
  const sdk = await loadSdk();
  const { items } = JSON.parse(readFileSync(args.fetched, "utf8"));
  // Compare the base branch's classifier with this branch's on the same cards.
  // The tier a card had when it was sent is not the base: it may come from an
  // older client, and a change that already shipped is not this PR's move.
  const baseTiers = classifyWithBase(items);
  for (const it of items) {
    if (!it.toolInput) continue;
    const after = rebuild(sdk, it);
    const from = baseTiers.get(it.id);
    if (!from) continue;
    if (from !== after.tier) moves.push({ shape: shapeOf(it), from, to: after.tier, kinds: [it.fields?.Kind, after.fields?.Kind] });
  }
}

/** Tier of each card under the base branch's packages/sdk/src, run with tsx. */
function classifyWithBase(items) {
  // Inside node_modules, so the base sources resolve @oked/receipt-core and tsx.
  const dir = join(REPO_ROOT, "node_modules", ".cache", "oked-gate-base");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const tar = execFileSync("git", ["archive", "--format=tar", base, "packages/sdk/src"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    writeFileSync(join(dir, "items.json"), JSON.stringify(items.filter((i) => i.toolInput).map((i) => ({ id: i.id, action: i.action, toolInput: i.toolInput }))));
    writeFileSync(join(dir, "run.mts"), [
      'import { readFileSync } from "node:fs";',
      'import { classify } from "./packages/sdk/src/classify.ts";',
      'const items = JSON.parse(readFileSync(new URL("./items.json", import.meta.url), "utf8"));',
      'console.log(JSON.stringify(items.map((i) => [i.id, classify(i.action, i.toolInput)])));',
    ].join("\n"));
    const out = execFileSync("npx", ["tsx", join(dir, "run.mts")], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return new Map(JSON.parse(out));
  } catch (e) {
    reasons.push(`could not run the ${base} classifier to compare tiers: ${String(e.message).split("\n")[0]}`);
    return new Map();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const m of moves) {
  if (TIER_ORDER[m.to] >= TIER_ORDER[m.from]) continue;
  if (m.from === "high_stakes") reasons.push(`lowers a high_stakes card to ${m.to}: ${m.shape}`);
  else if (m.kinds.some((k) => k && OUTWARD_OR_DESTRUCTIVE.test(k))) reasons.push(`lowers an outward or destructive card (${m.kinds.filter(Boolean).join("/")}) from ${m.from} to ${m.to}: ${m.shape}`);
}
const tierShapes = new Set(moves.map((m) => m.shape));
if (tierShapes.size > MAX_TIER_SHAPES) reasons.push(`${tierShapes.size} card shapes change tier (the limit is ${MAX_TIER_SHAPES})`);

for (const f of [CORPUS_PATH, CHANGES_PATH, LOG_PATH]) {
  let text = "";
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const hits = scan(text);
  if (hits.length) reasons.push(`${f.replace(REPO_ROOT + "/", "")} holds ${hits.length} secret or personal value(s)`);
}

if (!args["skip-tests"]) {
  try {
    execFileSync("npm", ["test", "--workspace=@oked/sdk"], { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    reasons.push("npm test --workspace=@oked/sdk fails");
  }
}

console.log(`tier moves: ${moves.length ? "" : "none"}`);
for (const m of moves) console.log(`  ${m.from} → ${m.to}  ${m.shape}`);
finish();

function finish() {
  if (reasons.length) {
    console.log("\nGATE: BLOCKED (leave the PR open for a person)");
    for (const r of reasons) console.log(`  - ${r}`);
    process.exit(1);
  }
  console.log("\nGATE: PASS");
  process.exit(0);
}
