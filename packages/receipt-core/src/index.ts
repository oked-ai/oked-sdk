export { canonicalize, jsonValue } from "./jcs.js";
export { sha256Digest, jcsDigest, subjectDigest, displayDigest, bodyDigest, DIGEST_PATTERN } from "./digest.js";
export {
  generateSigningSeed,
  publicKeyFromSeed,
  signerFromSeed,
  signBody,
  signatureValid,
  type ReceiptSigner,
} from "./sign.js";
export {
  verifyReceipt,
  verifySigned,
  verifyChain,
  keyCovers,
  type ReceiptCheck,
  type ReceiptProblem,
  type VerifyReceiptOptions,
  type ChainReport,
} from "./verify.js";
export { newReceiptId, shortReceiptId, chainIdFor, receiptDecision, responseDecision } from "./ids.js";
export type * from "./types.js";

/** Where OKed publishes its receipt keys. */
export const OKED_RECEIPT_KEYS_URL = "https://api.oked.ai/.well-known/oked-receipt-keys.json";
