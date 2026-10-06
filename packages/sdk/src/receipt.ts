import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  OKED_RECEIPT_KEYS_URL,
  jsonValue,
  responseDecision,
  verifyReceipt,
  type ReceiptKey,
  type SignedReceipt,
  type ToolCallSubject,
} from "@oked/receipt-core";
import { OKedReceiptError } from "./errors.js";
import { OKED_RECEIPT_KEYS_PATH } from "./config.js";
import { PINNED_RECEIPT_KEYS } from "./receipt-keys.js";

export interface ReceiptTrust {
  /** Use exactly these keys and never fetch (tests, self-hosted backends). */
  keys?: ReceiptKey[];
  /** Where to fetch a key not seen before. https only, except loopback for local dev. */
  keysUrl: string;
}

export interface SentRequest {
  action: string;
  description: unknown;
  toolInput: unknown;
  source: string;
  nonce: string;
}

function readCachedKeys(): ReceiptKey[] {
  try {
    const parsed = JSON.parse(readFileSync(OKED_RECEIPT_KEYS_PATH, "utf-8"));
    return Array.isArray(parsed?.keys) ? (parsed.keys as ReceiptKey[]) : [];
  } catch {
    return [];
  }
}

function writeCachedKeys(keys: ReceiptKey[]): void {
  try {
    mkdirSync(dirname(OKED_RECEIPT_KEYS_PATH), { recursive: true });
    writeFileSync(OKED_RECEIPT_KEYS_PATH, JSON.stringify({ keys }));
  } catch {
    // Best-effort; we fetch again next time.
  }
}

/** A key not seen before is accepted only over TLS (or from this machine, for local dev). */
export function keysUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

async function fetchKeys(url: string): Promise<ReceiptKey[]> {
  if (!keysUrlAllowed(url)) return [];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { keys?: unknown };
    return Array.isArray(body.keys) ? (body.keys as ReceiptKey[]) : [];
  } catch {
    return [];
  }
}

/**
 * Keys to verify `kid` with: pinned production keys and keys cached on disk,
 * fetching the published set (from the fixed OKed URL, never from the
 * configurable backend URL) only when the kid is unknown.
 */
export async function keysFor(kid: string, trust: ReceiptTrust): Promise<ReceiptKey[]> {
  if (trust.keys) return trust.keys;
  const known = [...PINNED_RECEIPT_KEYS, ...readCachedKeys()];
  if (known.some((k) => k.kid === kid)) return known;
  const fetched = await fetchKeys(trust.keysUrl);
  if (fetched.length > 0) writeCachedKeys(fetched);
  return [...PINNED_RECEIPT_KEYS, ...fetched];
}

/**
 * Check the receipt that came with a decision before anyone acts on it: a
 * valid signature by a published OKed key, for this request id, this
 * decision, and the exact action and nonce we sent. Throws OKedReceiptError
 * on any mismatch. A missing receipt throws only for an approval, when
 * `required`: a deny or timeout without one is a deny anyway.
 */
export async function checkReceipt(
  result: { approval_id: string | null; decision: string; receipt?: unknown },
  sent: SentRequest,
  opts: { required: boolean; trust: ReceiptTrust },
): Promise<SignedReceipt | undefined> {
  if (result.receipt === undefined || result.receipt === null) {
    if (opts.required && result.decision === "approved") throw new OKedReceiptError("missing", ["missing"]);
    return undefined;
  }
  const receipt = result.receipt as SignedReceipt;
  const kid = typeof receipt?.kid === "string" ? receipt.kid : "";
  const body = receipt?.body;
  if (!body || typeof body !== "object") throw new OKedReceiptError("malformed", ["malformed"]);

  const subject: ToolCallSubject = {
    type: "tool_call",
    operator_id: body.operator_id ?? null,
    request_id: result.approval_id ?? "",
    source: sent.source,
    action: sent.action,
    description: jsonValue(sent.description),
    tool_input: jsonValue(sent.toolInput),
    client_nonce: sent.nonce,
  };
  const check = verifyReceipt(receipt, { keys: await keysFor(kid, opts.trust), subject });
  const problems: string[] = [...check.problems];
  if (body.request_id !== result.approval_id) problems.push("request_mismatch");
  if (typeof body.decision !== "string" || responseDecision(body.decision) !== result.decision) {
    problems.push("decision_mismatch");
  }
  if (problems.length > 0) throw new OKedReceiptError(problems.join(", "), problems);
  return receipt;
}

export { OKED_RECEIPT_KEYS_URL };
