import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import {
  keysFor,
  loadOKedConfig,
  verifyChain,
  verifyReceipt,
  OKED_RECEIPT_KEYS_URL,
  type SignedReceipt,
} from "@oked/sdk";

/** The customer's own copy of every receipt this machine received. */
export const OKED_RECEIPTS_LOG = join(homedir(), ".oked", "receipts.jsonl");

/** Append one verified receipt. Best-effort: never blocks or breaks the agent. */
export function appendReceipt(receipt: SignedReceipt, path = OKED_RECEIPTS_LOG): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(receipt) + "\n", { mode: 0o600 });
  } catch {
    // The receipt is still stored by OKed; the local copy is a convenience.
  }
}

export interface LocalVerifyReport {
  total: number;
  valid: number;
  invalid: { line: number; receipt_id: string | null; problems: string[] }[];
  unparsable: number[];
  chains: ReturnType<typeof verifyChain>;
}

/**
 * Verify a receipts file: every signature against OKed's published keys, and
 * chain links between receipts that are adjacent. Gaps in seq are expected in a
 * local copy (other devices and agents share the operator's chain); a broken
 * link between adjacent receipts is not.
 */
export async function verifyReceiptsFile(path = OKED_RECEIPTS_LOG): Promise<LocalVerifyReport> {
  const keysUrl = process.env.OKED_RECEIPT_KEYS_URL || loadOKedConfig().receiptKeysUrl || OKED_RECEIPT_KEYS_URL;
  const lines = readFileSync(path, "utf-8").split("\n");
  const receipts: SignedReceipt[] = [];
  const report: LocalVerifyReport = { total: 0, valid: 0, invalid: [], unparsable: [], chains: [] };
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    report.total++;
    let receipt: SignedReceipt;
    try {
      receipt = JSON.parse(text) as SignedReceipt;
    } catch {
      report.unparsable.push(i + 1);
      continue;
    }
    const check = verifyReceipt(receipt, { keys: await keysFor(String(receipt?.kid ?? ""), { keysUrl }) });
    if (check.ok) {
      report.valid++;
      receipts.push(receipt);
    } else {
      report.invalid.push({ line: i + 1, receipt_id: receipt?.body?.receipt_id ?? null, problems: check.problems });
    }
  }
  report.chains = verifyChain(receipts);
  return report;
}
