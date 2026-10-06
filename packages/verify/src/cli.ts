#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { OKED_RECEIPT_KEYS_URL, type ReceiptKey, type ToolCallSubject } from "@oked/receipt-core";
import { fetchKeys, readBundle, verifyBundle, type VerifyReport } from "./index.js";

const USAGE = `Usage: oked-verify <bundle.zip | receipts.jsonl | receipt.json> [options]

Verifies OKed signed approval receipts offline: every signature against OKed's
public keys, each key's validity window, and the hash chain (missing receipts,
edited receipts, agreement with signed chain heads).

Options:
  --keys <keys.json>    Verify with these keys (default: the bundle's keys.json,
                        else ${OKED_RECEIPT_KEYS_URL})
  --keys-url <url>      Fetch keys from this URL instead (https)
  --subject <file>      The original request (subject_core JSON) for one receipt;
                        checks that the receipt is for exactly that action
  --json                Print the full report as JSON
  -h, --help            Show this help

Exit code 0 when everything verifies, 1 otherwise.`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function print(file: string, r: VerifyReport): void {
  console.log(`${file}`);
  console.log(`  ${plural(r.total, "receipt")}: ${r.valid} valid, ${r.invalid.length + r.unparsable.length} invalid`);
  const deciders = Object.entries(r.byDecider).map(([k, n]) => `${n} ${k}`).join(", ");
  const decisions = Object.entries(r.byDecision).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ");
  if (deciders) console.log(`  decided by: ${deciders}${r.samePerson ? ` (${r.samePerson} where the approver also ran the agent)` : ""}`);
  if (decisions) console.log(`  outcomes:   ${decisions}`);
  for (const bad of r.invalid) {
    console.log(`  INVALID ${bad.receipt_id ?? "(no id)"}${bad.seq !== null ? ` seq ${bad.seq}` : ""}: ${bad.problems.join(", ")}`);
  }
  for (const where of r.unparsable) console.log(`  INVALID ${where}: not JSON`);
  for (const c of r.chains) {
    const start = c.from_genesis ? "from seq 1" : `from seq ${c.first_seq} (partial export)`;
    console.log(`  chain ${c.chain_id}: ${plural(c.count, "receipt")}, ${start} to ${c.last_seq}`);
    for (const g of c.gaps) console.log(`    GAP: seq ${g.after + 1}..${g.before - 1} missing`);
    for (const b of c.breaks) console.log(`    BROKEN at seq ${b.seq}: ${b.reason}`);
    if (c.head) {
      const head = c.head.digest_matches === false ? "DOES NOT MATCH" : c.head.missing_tail ? "is ahead of this export" : "matches";
      console.log(`    signed chain head (seq ${c.head.seq}) ${head}`);
    }
  }
  for (const chain of r.badHeads) console.log(`  INVALID chain head for ${chain}`);
  if (r.subject) {
    console.log(`  subject for ${r.subject.request_id}: ${r.subject.matches ? "matches the receipt" : "DOES NOT MATCH"}`);
  }
  console.log(r.ok ? "OK" : "PROBLEMS FOUND");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("-") && !["--keys", "--keys-url", "--subject"].includes(args[i - 1]));
  if (!file || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return file ? 0 : 1;
  }
  const bundle = readBundle(file);
  const keysFile = arg(args, "--keys");
  const keysUrl = arg(args, "--keys-url");
  let keys: ReceiptKey[];
  if (keysFile) keys = JSON.parse(readFileSync(keysFile, "utf8")).keys;
  else if (keysUrl) keys = await fetchKeys(keysUrl);
  else keys = bundle.keys ?? (await fetchKeys());
  const subjectFile = arg(args, "--subject");
  const subject = subjectFile ? (JSON.parse(readFileSync(subjectFile, "utf8")) as ToolCallSubject) : undefined;

  const report = verifyBundle(bundle, keys, subject);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(file, report);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
