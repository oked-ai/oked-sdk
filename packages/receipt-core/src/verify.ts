import { bodyDigest, subjectDigest, DIGEST_PATTERN } from "./digest.js";
import { signatureValid } from "./sign.js";
import type { ChainHeadBody, ReceiptKey, ReceiptKeySet, Signed, SignedReceipt, ToolCallSubject } from "./types.js";

export type ReceiptProblem =
  | "malformed"
  | "unknown_kid"
  | "key_not_valid_at_issued_at"
  | "bad_signature"
  | "subject_mismatch";

export interface ReceiptCheck {
  ok: boolean;
  problems: ReceiptProblem[];
  /** The key that verified the signature, when one was found. */
  key?: ReceiptKey;
}

export interface VerifyReceiptOptions {
  keys: ReceiptKey[] | ReceiptKeySet;
  /** The original request. When given, subject_digest must match it. */
  subject?: ToolCallSubject;
}

const DECISIONS = new Set(["approved", "denied", "timed_out"]);
const KINDS = new Set(["human", "rule", "system"]);

function keyList(keys: ReceiptKey[] | ReceiptKeySet): ReceiptKey[] {
  return Array.isArray(keys) ? keys : keys.keys ?? [];
}

function isEnvelope(x: unknown): x is Signed<Record<string, unknown>> {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    !!e.body && typeof e.body === "object" && !Array.isArray(e.body) &&
    e.alg === "Ed25519" && typeof e.kid === "string" && typeof e.sig === "string"
  );
}

function isReceiptShape(x: unknown): x is SignedReceipt {
  if (!isEnvelope(x)) return false;
  const b = x.body as Record<string, unknown>;
  const decider = b.decider as Record<string, unknown> | undefined;
  return (
    b.v === 1 &&
    typeof b.receipt_id === "string" &&
    typeof b.chain_id === "string" &&
    Number.isInteger(b.seq) && (b.seq as number) >= 1 &&
    typeof b.issued_at === "string" &&
    typeof b.request_id === "string" &&
    typeof b.subject_digest === "string" && DIGEST_PATTERN.test(b.subject_digest) &&
    typeof b.decision === "string" && DECISIONS.has(b.decision) &&
    !!decider && typeof decider.kind === "string" && KINDS.has(decider.kind) &&
    (b.prev_receipt_digest === null || (typeof b.prev_receipt_digest === "string" && DIGEST_PATTERN.test(b.prev_receipt_digest)))
  );
}

/** A key covers an instant when not_before <= t and (no not_after or t < not_after). */
export function keyCovers(key: ReceiptKey, isoTime: string): boolean {
  const t = Date.parse(isoTime);
  if (Number.isNaN(t)) return false;
  if (Date.parse(key.not_before) > t) return false;
  return key.not_after === null || t < Date.parse(key.not_after);
}

/** Verify any signed OKed document (receipt or chain head) against a key set. */
export function verifySigned(
  envelope: unknown,
  keys: ReceiptKey[] | ReceiptKeySet,
  issuedAt?: string,
): ReceiptCheck {
  if (!isEnvelope(envelope)) return { ok: false, problems: ["malformed"] };
  const key = keyList(keys).find((k) => k.kid === envelope.kid && k.alg === "Ed25519");
  if (!key) return { ok: false, problems: ["unknown_kid"] };
  const problems: ReceiptProblem[] = [];
  const at = issuedAt ?? (envelope.body.issued_at as string | undefined);
  if (typeof at !== "string" || !keyCovers(key, at)) problems.push("key_not_valid_at_issued_at");
  if (!signatureValid(envelope, key)) problems.push("bad_signature");
  return { ok: problems.length === 0, problems, key };
}

/**
 * Check one receipt: shape, a known key whose window covers issued_at, the
 * signature, and, when the original request is given, the subject digest.
 */
export function verifyReceipt(receipt: unknown, opts: VerifyReceiptOptions): ReceiptCheck {
  if (!isReceiptShape(receipt)) return { ok: false, problems: ["malformed"] };
  const check = verifySigned(receipt, opts.keys);
  if (opts.subject) {
    const s = opts.subject;
    const matches =
      s.request_id === receipt.body.request_id &&
      s.operator_id === receipt.body.operator_id &&
      subjectDigest(s) === receipt.body.subject_digest;
    if (!matches) {
      check.problems.push("subject_mismatch");
      check.ok = false;
    }
  }
  return check;
}

export interface ChainReport {
  chain_id: string;
  count: number;
  first_seq: number;
  last_seq: number;
  /** True when the receipts start at seq 1, so the first link is checkable too. */
  from_genesis: boolean;
  /** Missing runs of seq between receipts we have, e.g. { after: 4, before: 7 }. */
  gaps: { after: number; before: number }[];
  /** A receipt whose prev_receipt_digest does not match the receipt before it, or a repeated seq. */
  breaks: { seq: number; reason: "prev_digest_mismatch" | "duplicate_seq" | "genesis_has_prev" }[];
  /**
   * Set when a chain head was given. digest_matches is null when the receipt
   * at the head's seq is not in the set; missing_tail means the head is ahead
   * of the newest receipt we have.
   */
  head?: { seq: number; digest_matches: boolean | null; missing_tail: boolean };
}

/**
 * Check chain integrity over a set of receipts (an export, or a local copy).
 * Signatures are not checked here; run verifyReceipt on each receipt too.
 * A local copy from one device legitimately has gaps: other devices of the
 * same operator share the chain.
 */
export function verifyChain(receipts: SignedReceipt[], heads: ChainHeadBody[] = []): ChainReport[] {
  const byChain = new Map<string, SignedReceipt[]>();
  for (const r of receipts) {
    const list = byChain.get(r.body.chain_id) ?? [];
    list.push(r);
    byChain.set(r.body.chain_id, list);
  }
  const reports: ChainReport[] = [];
  for (const [chainId, list] of byChain) {
    list.sort((a, b) => a.body.seq - b.body.seq);
    const report: ChainReport = {
      chain_id: chainId,
      count: list.length,
      first_seq: list[0].body.seq,
      last_seq: list[list.length - 1].body.seq,
      from_genesis: list[0].body.seq === 1,
      gaps: [],
      breaks: [],
    };
    if (list[0].body.seq === 1 && list[0].body.prev_receipt_digest !== null) {
      report.breaks.push({ seq: 1, reason: "genesis_has_prev" });
    }
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1].body;
      const cur = list[i].body;
      if (cur.seq === prev.seq) {
        report.breaks.push({ seq: cur.seq, reason: "duplicate_seq" });
      } else if (cur.seq === prev.seq + 1) {
        if (cur.prev_receipt_digest !== bodyDigest(prev)) {
          report.breaks.push({ seq: cur.seq, reason: "prev_digest_mismatch" });
        }
      } else {
        report.gaps.push({ after: prev.seq, before: cur.seq });
      }
    }
    const head = heads.find((h) => h.chain_id === chainId);
    if (head) {
      const atHead = list.find((r) => r.body.seq === head.seq);
      report.head = {
        seq: head.seq,
        digest_matches: atHead ? bodyDigest(atHead.body) === head.digest : null,
        missing_tail: report.last_seq < head.seq,
      };
    }
    reports.push(report);
  }
  return reports;
}
