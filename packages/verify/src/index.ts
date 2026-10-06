import { readFileSync } from "node:fs";
import {
  OKED_RECEIPT_KEYS_URL,
  verifyChain,
  verifyReceipt,
  verifySigned,
  type ChainHeadBody,
  type ChainReport,
  type ReceiptKey,
  type ReceiptProblem,
  type SignedChainHead,
  type SignedReceipt,
  type ToolCallSubject,
} from "@oked/receipt-core";
import { unzip } from "./unzip.js";

export interface Bundle {
  receipts: SignedReceipt[];
  /** Keys shipped with the bundle (keys.json), if any. */
  keys?: ReceiptKey[];
  /** Signed chain heads shipped with the bundle (chain-head.json), if any. */
  heads?: SignedChainHead[];
  /** Lines or entries that were not valid JSON. */
  unparsable: string[];
}

function parseJsonLines(text: string, where: string, unparsable: string[]): SignedReceipt[] {
  const out: SignedReceipt[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as SignedReceipt);
    } catch {
      unparsable.push(`${where}:${i + 1}`);
    }
  });
  return out;
}

/**
 * Read a receipt source: an export bundle (.zip with receipts.jsonl,
 * keys.json, chain-head.json), a .jsonl file (one receipt per line, e.g.
 * ~/.oked/receipts.jsonl), or a .json file with one receipt or an array.
 */
export function readBundle(path: string): Bundle {
  const raw = readFileSync(path);
  const unparsable: string[] = [];
  if (raw.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const files = unzip(raw);
    const receipts = parseJsonLines(files.get("receipts.jsonl")?.toString("utf8") ?? "", "receipts.jsonl", unparsable);
    const keys = files.has("keys.json") ? (JSON.parse(files.get("keys.json")!.toString("utf8")).keys as ReceiptKey[]) : undefined;
    const heads = files.has("chain-head.json")
      ? (JSON.parse(files.get("chain-head.json")!.toString("utf8")) as SignedChainHead[])
      : undefined;
    return { receipts, keys, heads, unparsable };
  }
  const text = raw.toString("utf8");
  if (path.endsWith(".jsonl")) return { receipts: parseJsonLines(text, path, unparsable), unparsable };
  const parsed = JSON.parse(text);
  return { receipts: Array.isArray(parsed) ? parsed : [parsed], unparsable };
}

/** Fetch OKed's published keys. https only. */
export async function fetchKeys(url = OKED_RECEIPT_KEYS_URL): Promise<ReceiptKey[]> {
  if (!url.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
    throw new Error(`refusing to fetch keys over plain http: ${url}`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`could not fetch keys from ${url}: HTTP ${res.status}`);
  return ((await res.json()) as { keys: ReceiptKey[] }).keys;
}

export interface VerifyReport {
  total: number;
  valid: number;
  invalid: { receipt_id: string | null; seq: number | null; problems: ReceiptProblem[] }[];
  unparsable: string[];
  /** Valid receipts by who decided: human, rule, system. */
  byDecider: Record<string, number>;
  /** Valid receipts by outcome: approved, denied, timed_out. */
  byDecision: Record<string, number>;
  /** Human decisions where the approver also ran the agent. */
  samePerson: number;
  chains: ChainReport[];
  /** Chain heads that failed their own signature check. */
  badHeads: string[];
  /** Set when a subject was given (one receipt): does it match? */
  subject?: { request_id: string; matches: boolean };
  ok: boolean;
}

/**
 * Verify a set of receipts: every signature and key window, the hash chain
 * (gaps, broken links, agreement with signed chain heads) and, for one
 * receipt, the original request when given.
 */
export function verifyBundle(bundle: Bundle, keys: ReceiptKey[], subject?: ToolCallSubject): VerifyReport {
  const report: VerifyReport = {
    total: bundle.receipts.length + bundle.unparsable.length,
    valid: 0,
    invalid: [],
    unparsable: bundle.unparsable,
    byDecider: {},
    byDecision: {},
    samePerson: 0,
    chains: [],
    badHeads: [],
    ok: false,
  };
  const valid: SignedReceipt[] = [];
  for (const r of bundle.receipts) {
    const check = verifyReceipt(r, { keys });
    if (!check.ok) {
      report.invalid.push({ receipt_id: r?.body?.receipt_id ?? null, seq: r?.body?.seq ?? null, problems: check.problems });
      continue;
    }
    report.valid++;
    valid.push(r);
    report.byDecider[r.body.decider.kind] = (report.byDecider[r.body.decider.kind] ?? 0) + 1;
    report.byDecision[r.body.decision] = (report.byDecision[r.body.decision] ?? 0) + 1;
    if (r.body.same_person) report.samePerson++;
  }

  const heads: ChainHeadBody[] = [];
  for (const h of bundle.heads ?? []) {
    if (verifySigned(h, keys).ok) heads.push(h.body);
    else report.badHeads.push(h?.body?.chain_id ?? "(unknown chain)");
  }
  report.chains = verifyChain(valid, heads);

  if (subject) {
    const target = bundle.receipts.find((r) => r?.body?.request_id === subject.request_id);
    report.subject = {
      request_id: subject.request_id,
      matches: !!target && verifyReceipt(target, { keys, subject }).ok,
    };
  }

  report.ok =
    report.invalid.length === 0 &&
    report.unparsable.length === 0 &&
    report.badHeads.length === 0 &&
    report.chains.every((c) => c.breaks.length === 0 && c.head?.digest_matches !== false) &&
    (report.subject?.matches ?? true);
  return report;
}

export { unzip };
