#!/usr/bin/env node
// Fetch the cards that reached a person since the last run, and group them.
//
//   node scripts/approval-review/fetch.mjs --out <file.json> [--since <ISO>]
//   node scripts/approval-review/fetch.mjs --advance <ISO>   (save the cursor after a run)
//
// The output file holds { since, until, items, groups }. Each group has the
// signals the review uses: times shown, approved, denied, timed out, decided
// by a rule, and the median seconds to decide.
import { writeFileSync } from "node:fs";
import { loadConfig, readState, writeState, shapeOf, parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.advance) {
  const at = new Date(args.advance);
  if (Number.isNaN(at.getTime())) throw new Error("--advance needs an ISO date");
  writeState({ ...readState(), cursor: at.toISOString(), lastRunAt: new Date().toISOString() });
  console.log(`cursor saved: ${at.toISOString()}`);
  process.exit(0);
}

if (!args.out) {
  console.error("usage: fetch.mjs --out <file.json> [--since <ISO>] | --advance <ISO>");
  process.exit(2);
}

const { apiKey, backendUrl } = loadConfig();
const since = args.since || readState().cursor || new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

const items = [];
let cursor = since;
for (;;) {
  const url = `${backendUrl}/api/v1/history?since=${encodeURIComponent(cursor)}&limit=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /api/v1/history: ${res.status} ${await res.text()}`);
  const page = await res.json();
  items.push(...page);
  if (page.length < 200) break;
  cursor = page[page.length - 1].createdAt;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const byShape = new Map();
for (const it of items) {
  const key = shapeOf(it);
  const g = byShape.get(key) ?? { shape: key, action: it.action, kind: it.fields?.Kind ?? null, tiers: {}, shown: 0, approved: 0, denied: 0, timedOut: 0, byRule: 0, secondsToDecide: [], ids: [] };
  g.shown++;
  g.tiers[it.tier] = (g.tiers[it.tier] ?? 0) + 1;
  if (it.decidedVia === "rule") g.byRule++;
  if (it.decision === "approved") g.approved++;
  else if (it.decision === "denied") g.denied++;
  else g.timedOut++;
  if (it.decidedAt && it.decidedVia !== "rule") {
    g.secondsToDecide.push((new Date(it.decidedAt) - new Date(it.createdAt)) / 1000);
  }
  g.ids.push(it.id);
  byShape.set(key, g);
}

const groups = [...byShape.values()]
  .map(({ secondsToDecide, ...g }) => ({ ...g, medianSecondsToDecide: median(secondsToDecide) }))
  .sort((a, b) => b.shown - a.shown);

const until = items.length ? items[items.length - 1].createdAt : since;
writeFileSync(args.out, JSON.stringify({ since, until, items, groups }, null, 2));

console.log(`${items.length} cards since ${since}, ${groups.length} shapes. Last card: ${until}`);
for (const g of groups) {
  const t = Object.entries(g.tiers).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  ${String(g.shown).padStart(3)}×  ✅${g.approved} ❌${g.denied} ⏱${g.timedOut} rule:${g.byRule}  ~${g.medianSecondsToDecide ?? "-"}s  [${t}]  ${g.shape}`);
}
