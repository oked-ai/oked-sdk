import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.js";
import type { Digest, DisplayShown, ToolCallSubject } from "./types.js";

/** `sha256:` + lowercase hex of SHA-256 over the UTF-8 bytes of `text`. */
export function sha256Digest(text: string): Digest {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Digest of any JSON value's canonical form. */
export function jcsDigest(value: unknown): Digest {
  return sha256Digest(canonicalize(value));
}

/** What was authorized. */
export function subjectDigest(subject: ToolCallSubject): Digest {
  return jcsDigest(subject);
}

/** What the approver was shown. */
export function displayDigest(shown: DisplayShown): Digest {
  return jcsDigest(shown);
}

/** A signed body's digest; the next receipt's prev_receipt_digest. */
export function bodyDigest(body: unknown): Digest {
  return jcsDigest(body);
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
