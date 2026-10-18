#!/usr/bin/env node
// Rebuild each fetched card with the SDK on this branch and show what changes.
//
//   node scripts/approval-review/diff.mjs <fetched.json> [--out <diff.json>]
//
// "before" is the tier and fields the person really saw (from the backend).
// "after" is what this branch's classify() and describeFields() give for the
// same stored tool input. Build the SDK first: npm run build --workspace=@oked/sdk
import { readFileSync, writeFileSync } from "node:fs";
import { loadSdk, rebuild, sameFields, shapeOf, parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) {
  console.error("usage: diff.mjs <fetched.json> [--out <diff.json>]");
  process.exit(2);
}

const sdk = await loadSdk();
const { items } = JSON.parse(readFileSync(file, "utf8"));

const changed = [];
let unchanged = 0;
let noInput = 0;
for (const it of items) {
  if (!it.toolInput || typeof it.toolInput !== "object") {
    noInput++;
    continue;
  }
  const after = rebuild(sdk, it);
  const before = { tier: it.tier, fields: it.fields ?? {} };
  const tierChanged = before.tier !== after.tier;
  const textChanged = !sameFields(before.fields, after.fields);
  if (!tierChanged && !textChanged) {
    unchanged++;
    continue;
  }
  changed.push({ id: it.id, createdAt: it.createdAt, action: it.action, shape: shapeOf(it), decision: it.decision, before, after, tierChanged, textChanged });
}

if (args.out) writeFileSync(args.out, JSON.stringify({ changed, unchanged, noInput }, null, 2));

console.log(`${changed.length} cards change, ${unchanged} stay the same, ${noInput} have no tool input.`);
const seen = new Set();
for (const c of changed) {
  if (seen.has(c.shape)) continue;
  seen.add(c.shape);
  const n = changed.filter((x) => x.shape === c.shape).length;
  console.log(`\n${n}× ${c.shape}`);
  console.log(`  before: [${c.before.tier}] ${c.before.fields.Title ?? ""}${c.before.fields.Target ? ` · ${c.before.fields.Target}` : ""}`);
  console.log(`  after:  [${c.after.tier}] ${c.after.fields.Title ?? ""}${c.after.fields.Target ? ` · ${c.after.fields.Target}` : ""}`);
}
