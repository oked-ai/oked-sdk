import { randomBytes } from "node:crypto";
import type { ReceiptDecision } from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `rcpt_` + 26 Crockford base32 characters (128 random bits). */
export function newReceiptId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return `rcpt_${out}`;
}

/** The short form shown in Telegram and the dashboard, e.g. `rcpt_7Q2F`. */
export function shortReceiptId(receiptId: string): string {
  return receiptId.slice(0, 9);
}

/** Chain key: per operator, or per API key for a key with no operator. */
export function chainIdFor(operatorId: string | null, apiKeyId: string | null): string {
  if (operatorId) return `op_${operatorId}`;
  if (apiKeyId) return `key_${apiKeyId}`;
  throw new Error("a receipt chain needs an operator or an API key");
}

/** DB status -> receipt decision. The DB says "timeout"; receipts say "timed_out". */
export function receiptDecision(status: string): ReceiptDecision {
  if (status === "approved" || status === "denied") return status;
  if (status === "timeout") return "timed_out";
  throw new Error(`no receipt decision for status ${JSON.stringify(status)}`);
}

/** Receipt decision -> the decision string /approve returns to clients. */
export function responseDecision(decision: ReceiptDecision): "approved" | "denied" | "timeout" {
  return decision === "timed_out" ? "timeout" : decision;
}
