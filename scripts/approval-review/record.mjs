#!/usr/bin/env node
// The before/after record of every card the review loop changed.
// docs/approval-review/changes.jsonl is the source; LOG.md and the artifact
// page rows are built from it.
//
//   record.mjs add --type tier|text|layout --reason <text> --run <id>
//                  (--diff <diff.json> --shape <shape> | --before <json> --after <json> [--subject <text>])
//                  [--corpus <id>] [--files a,b]
//   record.mjs pr <url> --run <id>     set the PR link on this run's entries
//   record.mjs log                     rebuild LOG.md
//   record.mjs rows [--run <id>]       print artifact page rows (JSON)
//
// --before/--after take {"tier": ..., "fields": {...}} for a card, or
// {"telegram": "<html>"} for a layout change.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CHANGES_PATH, LOG_PATH, readJsonl, parseArgs } from "./lib.mjs";
import { sanitize } from "./sanitize.mjs";

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

const TIER_TEXT = {
  high_stakes: "🔴 high stakes (Face ID)",
  review: "🔵 review (asks you)",
  warning: "🟡 warning (logged, no card)",
  safe: "⚪ safe (no card)",
};
const FIELD_ORDER = ["Title", "Target", "Annotation", "Subline", "Body", "Footnote", "Kind"];

if (cmd === "add") add();
else if (cmd === "pr") setPr();
else if (cmd === "log") writeLog();
else if (cmd === "rows") console.log(JSON.stringify(rows(args.run), null, 2));
else {
  console.error("usage: record.mjs add|pr|log|rows (see the header)");
  process.exit(2);
}

function add() {
  for (const k of ["type", "reason", "run"]) if (!args[k]) throw new Error(`--${k} is required`);
  let before, after, subject, count = 1, decisions;
  if (args.diff) {
    const { changed } = JSON.parse(readFileSync(args.diff, "utf8"));
    const same = changed.filter((c) => c.shape === args.shape);
    if (!same.length) throw new Error(`no changed card with shape: ${args.shape}`);
    ({ before, after } = same[0]);
    subject = same[0].action;
    count = same.length;
    decisions = { approved: same.filter((c) => c.decision === "approved").length, denied: same.filter((c) => c.decision === "denied").length };
  } else {
    before = JSON.parse(args.before);
    after = JSON.parse(args.after);
    subject = args.subject || "all cards";
  }
  const all = readJsonl(CHANGES_PATH);
  const entry = sanitize({
    id: `${args.run}-${String(all.filter((e) => e.run === args.run).length + 1).padStart(2, "0")}`,
    run: args.run,
    date: new Date().toISOString().slice(0, 10),
    type: args.type,
    subject,
    shape: args.shape ?? null,
    reason: args.reason,
    count,
    decisions: decisions ?? null,
    before,
    after,
    corpus: args.corpus ?? null,
    files: args.files ? String(args.files).split(",") : [],
    pr: null,
  });
  mkdirSync(dirname(CHANGES_PATH), { recursive: true });
  appendFileSync(CHANGES_PATH, JSON.stringify(entry) + "\n");
  console.log(`recorded ${entry.id}`);
}

function setPr() {
  const url = args._[1];
  if (!url || !args.run) throw new Error("usage: record.mjs pr <url> --run <id>");
  const all = readJsonl(CHANGES_PATH).map((e) => (e.run === args.run && !e.pr ? { ...e, pr: url } : e));
  writeFileSync(CHANGES_PATH, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function rows(run) {
  return readJsonl(CHANGES_PATH).filter((e) => !run || e.run === run);
}

function cell(s) {
  if (s === undefined || s === null || s === "") return "·";
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function writeLog() {
  const all = readJsonl(CHANGES_PATH).reverse();
  const out = [
    "# Approval card changes",
    "",
    "Every change the approval review loop made to a card's tier, text or layout, newest first.",
    "Built from `changes.jsonl` by `node scripts/approval-review/record.mjs log`. Do not edit by hand.",
    "",
  ];
  for (const e of all) {
    out.push(`## ${e.date} · ${e.type} · \`${e.subject}\``, "");
    out.push(`**Why:** ${e.reason}`, "");
    if (e.before?.telegram !== undefined) {
      out.push("**Before**", "", "```html", e.before.telegram, "```", "", "**After**", "", "```html", e.after.telegram, "```", "");
    } else {
      out.push("| | Before | After |", "|---|---|---|");
      out.push(`| Tier | ${TIER_TEXT[e.before.tier] ?? cell(e.before.tier)} | ${TIER_TEXT[e.after.tier] ?? cell(e.after.tier)} |`);
      for (const k of FIELD_ORDER) {
        const b = e.before.fields?.[k];
        const a = e.after.fields?.[k];
        if (b === undefined && a === undefined) continue;
        out.push(`| ${k} | ${cell(b)} | ${cell(a)} |`);
      }
      out.push("");
    }
    const facts = [];
    if (e.count > 1 || e.decisions) facts.push(`Seen ${e.count}×${e.decisions ? ` (✅ ${e.decisions.approved}, ❌ ${e.decisions.denied})` : ""}`);
    if (e.corpus) facts.push(`Corpus: \`${e.corpus}\``);
    if (e.pr) facts.push(`PR: ${e.pr}`);
    if (facts.length) out.push(facts.join(" · "), "");
  }
  writeFileSync(LOG_PATH, out.join("\n"));
  console.log(`wrote ${LOG_PATH} (${all.length} changes)`);
}
