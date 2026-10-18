#!/usr/bin/env node
// Add a real card to the corpus (packages/sdk/test/fixtures/approval-corpus.jsonl).
//
//   node scripts/approval-review/corpus.mjs add --from <fetched.json> --request <id> --name <slug>
//   node scripts/approval-review/corpus.mjs add --tool <name> --input '<json>' --name <slug> --source <text>
//
// The tool input is sanitized first. The expected tier and fields come from
// this branch's SDK, so run it AFTER the fix: the line then pins the fixed card.
// An existing id is never overwritten; to change a pinned card, edit its line
// by hand in the same commit as the code change, so the diff shows both.
import { readFileSync, appendFileSync } from "node:fs";
import { CORPUS_PATH, loadSdk, readJsonl, parseArgs } from "./lib.mjs";
import { sanitize } from "./sanitize.mjs";

const args = parseArgs(process.argv.slice(2));
if (args._[0] !== "add" || !args.name) {
  console.error("usage: corpus.mjs add (--from <fetched.json> --request <id> | --tool <name> --input <json> --source <text>) --name <slug>");
  process.exit(2);
}

let tool, input, source;
if (args.from) {
  const { items } = JSON.parse(readFileSync(args.from, "utf8"));
  const it = items.find((x) => x.id === args.request);
  if (!it) throw new Error(`request ${args.request} is not in ${args.from}`);
  if (!it.toolInput) throw new Error(`request ${args.request} has no tool input`);
  tool = it.action;
  input = it.toolInput;
  source = it.receiptId ? `receipt ${it.receiptId.slice(0, 13)}` : `request ${it.id.slice(0, 8)}`;
} else {
  tool = args.tool;
  input = JSON.parse(args.input);
  source = args.source || "hand-written";
}

const date = new Date().toISOString().slice(0, 10);
const id = `${date}-${args.name}`;
if (readJsonl(CORPUS_PATH).some((c) => c.id === id)) throw new Error(`corpus id ${id} exists`);

const sdk = await loadSdk();
const clean = sanitize(input);
// No cwd: the expected card must not depend on files on this machine.
const line = { id, source, tool, input: clean, tier: sdk.classify(tool, clean), fields: sdk.describeFields(tool, clean) };
appendFileSync(CORPUS_PATH, JSON.stringify(line) + "\n");
console.log(`added ${id}: [${line.tier}] ${line.fields?.Title}`);
