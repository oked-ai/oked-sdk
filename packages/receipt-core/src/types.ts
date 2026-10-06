/** A JSON value as it travels over the wire (after a JSON round-trip). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** `sha256:` followed by 64 lowercase hex characters. */
export type Digest = `sha256:${string}`;

export type ReceiptDecision = "approved" | "denied" | "timed_out";
export type DeciderKind = "human" | "rule" | "system";
export type Assurance = "none" | "channel" | "passkey";
export type DecisionChannel = "telegram" | "dashboard";
/** Why a system decider decided. Null for human and rule deciders. */
export type SystemReason = "timeout" | "classified_safe";
export type RiskTier = "safe" | "warning" | "review" | "high_stakes";

export interface ReceiptDecider {
  kind: DeciderKind;
  operator_id: string | null;
  display_name: string | null;
  assurance: Assurance;
  channel: DecisionChannel | null;
  rule_id: string | null;
  reason: SystemReason | null;
}

export interface ReceiptRequester {
  operator_id: string | null;
  api_key_id: string | null;
  /** The integration that asked, e.g. "@oked/claude-code@0.5.0". Null for older clients. */
  client: string | null;
}

/** The signed part of a receipt. Every field is covered by the signature. */
export interface ReceiptBody {
  v: 1;
  receipt_id: string;
  /** "op_<operatorId>", or "key_<apiKeyId>" for a key with no operator. */
  chain_id: string;
  /** Position in the chain, starting at 1, with no gaps. */
  seq: number;
  issued_at: string;
  issuer: string;
  operator_id: string | null;
  request_id: string;
  subject_type: "tool_call";
  /** What was authorized: sha256(JCS(subject_core)). */
  subject_digest: Digest;
  /** What the approver was shown: sha256(JCS(shown)). Null when nothing was rendered. */
  display_digest: Digest | null;
  /** The rendered title. Null when the operator turned summaries off. */
  summary: string | null;
  risk_tier: RiskTier;
  decision: ReceiptDecision;
  decided_at: string;
  decider: ReceiptDecider;
  requester: ReceiptRequester;
  /** True only for a human decider whose operator is also the requester's. */
  same_person: boolean;
  /** body_digest of the previous receipt in this chain. Null for seq 1. */
  prev_receipt_digest: Digest | null;
}

/** Any signed OKed document: a body plus an Ed25519 signature over JCS(body). */
export interface Signed<B> {
  body: B;
  alg: "Ed25519";
  kid: string;
  /** base64url (no padding) Ed25519 signature over the UTF-8 bytes of JCS(body). */
  sig: string;
}

export type SignedReceipt = Signed<ReceiptBody>;

/** The latest position of one chain, signed so a customer can keep checkpoints. */
export interface ChainHeadBody {
  v: 1;
  type: "chain_head";
  chain_id: string;
  operator_id: string | null;
  seq: number;
  /** body_digest of the receipt at `seq`. Null for an empty chain. */
  digest: Digest | null;
  issued_at: string;
  issuer: string;
}

export type SignedChainHead = Signed<ChainHeadBody>;

/** One entry of /.well-known/oked-receipt-keys.json. */
export interface ReceiptKey {
  kid: string;
  alg: "Ed25519";
  /** base64url (no padding) of the raw 32-byte Ed25519 public key. */
  public_key: string;
  not_before: string;
  /** Null while the key is active. Retired keys stay listed with a not_after. */
  not_after: string | null;
}

export interface ReceiptKeySet {
  keys: ReceiptKey[];
}

/**
 * subject_core for a hook or SDK tool call: the exact action that was
 * authorized, as the client sent it. Values are JSON as received (missing
 * becomes null), so client and server hash identical bytes.
 */
export interface ToolCallSubject {
  type: "tool_call";
  operator_id: string | null;
  request_id: string;
  source: string;
  action: string;
  description: JsonValue;
  tool_input: JsonValue;
  /** Random per request, chosen by the client, so an old receipt cannot be replayed. */
  client_nonce: string | null;
}

/** What the approver was shown: the classification row that rendered the card. */
export interface DisplayShown {
  classifier_version: string;
  tier: string;
  title: string;
  target: string | null;
  annotation: string | null;
  subline: string | null;
  body: string | null;
  footnote: string | null;
}
