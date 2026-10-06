import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalize,
  jsonValue,
  subjectDigest,
  displayDigest,
  bodyDigest,
  signerFromSeed,
  signBody,
  generateSigningSeed,
  publicKeyFromSeed,
  verifyReceipt,
  verifySigned,
  verifyChain,
  newReceiptId,
  shortReceiptId,
  chainIdFor,
  receiptDecision,
  responseDecision,
  type ReceiptKey,
  type SignedReceipt,
  type ToolCallSubject,
} from "../src/index.js";

const jcsVectors = JSON.parse(readFileSync(new URL("./vectors/jcs.json", import.meta.url), "utf8")) as {
  name: string;
  input: string;
  canonical: string;
}[];
const golden = JSON.parse(readFileSync(new URL("./vectors/receipt-v1.json", import.meta.url), "utf8"));
const key: ReceiptKey = {
  kid: golden.key.kid,
  alg: "Ed25519",
  public_key: golden.key.public_key,
  not_before: golden.key.not_before,
  not_after: golden.key.not_after,
};
const r1 = golden.receipts[0].envelope as SignedReceipt;
const r2 = golden.receipts[1].envelope as SignedReceipt;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("canonicalize (RFC 8785)", () => {
  for (const v of jcsVectors) {
    it(v.name, () => assert.equal(canonicalize(JSON.parse(v.input)), v.canonical));
  }

  it("refuses values JSON cannot carry", () => {
    assert.throws(() => canonicalize({ a: undefined }), TypeError);
    assert.throws(() => canonicalize(Number.NaN), TypeError);
    assert.throws(() => canonicalize(Infinity), TypeError);
    assert.throws(() => canonicalize(() => 1), TypeError);
  });

  it("jsonValue gives what the other side of a JSON request sees", () => {
    assert.equal(jsonValue(undefined), null);
    assert.deepEqual(jsonValue({ a: 1, b: undefined, c: [undefined, NaN] }), { a: 1, c: [null, null] });
    assert.equal(jsonValue(new Date("2026-10-05T00:00:00Z")), "2026-10-05T00:00:00.000Z");
  });
});

describe("golden vectors", () => {
  it("reproduce the subject and display digests", () => {
    assert.equal(canonicalize(golden.subject), golden.subject_jcs);
    assert.equal(subjectDigest(golden.subject), golden.subject_digest);
    assert.equal(displayDigest(golden.shown), golden.display_digest);
  });

  it("reproduce body bytes, digests and signatures from the test seed", () => {
    const signer = signerFromSeed(golden.key.seed, golden.key.kid);
    assert.equal(signer.publicKey, golden.key.public_key);
    for (const r of golden.receipts) {
      assert.equal(canonicalize(r.envelope.body), r.body_jcs);
      assert.equal(bodyDigest(r.envelope.body), r.body_digest);
      assert.deepEqual(signBody(r.envelope.body, signer), r.envelope, "Ed25519 is deterministic");
    }
    assert.equal(r2.body.prev_receipt_digest, golden.receipts[0].body_digest);
  });

  it("verify against the published key set shape", () => {
    assert.deepEqual(verifyReceipt(r1, { keys: { keys: [key] } }), { ok: true, problems: [], key });
    assert.equal(verifyReceipt(r2, { keys: [key] }).ok, true);
    assert.equal(verifySigned(golden.chain_head, [key]).ok, true);
  });
});

describe("verifyReceipt", () => {
  it("one changed byte in the body fails the signature", () => {
    const tampered = clone(r1);
    tampered.body.decision = "denied";
    assert.deepEqual(verifyReceipt(tampered, { keys: [key] }).problems, ["bad_signature"]);

    const renamed = clone(r1);
    renamed.body.summary = "Force-push to mail";
    assert.equal(verifyReceipt(renamed, { keys: [key] }).ok, false);
  });

  it("a changed signature fails", () => {
    const bad = clone(r1);
    bad.sig = (bad.sig[0] === "A" ? "B" : "A") + bad.sig.slice(1);
    assert.deepEqual(verifyReceipt(bad, { keys: [key] }).problems, ["bad_signature"]);
  });

  it("a receipt signed by another key does not verify under OKed's kid", () => {
    const other = signerFromSeed(generateSigningSeed().seed, key.kid);
    const forged = signBody(r1.body, other);
    assert.deepEqual(verifyReceipt(forged, { keys: [key] }).problems, ["bad_signature"]);
  });

  it("an unknown kid is reported, not trusted", () => {
    const unknown = { ...clone(r1), kid: "someone-else" };
    assert.deepEqual(verifyReceipt(unknown, { keys: [key] }).problems, ["unknown_kid"]);
  });

  it("the key window must cover issued_at", () => {
    const notYet = { ...key, not_before: "2026-11-01T00:00:00.000Z" };
    assert.deepEqual(verifyReceipt(r1, { keys: [notYet] }).problems, ["key_not_valid_at_issued_at"]);
    const retired = { ...key, not_after: "2026-10-05T09:00:00.000Z" };
    assert.deepEqual(verifyReceipt(r1, { keys: [retired] }).problems, ["key_not_valid_at_issued_at"]);
    const retiredLater = { ...key, not_after: "2027-10-01T00:00:00.000Z" };
    assert.equal(verifyReceipt(r1, { keys: [retiredLater] }).ok, true);
  });

  it("rejects malformed input", () => {
    for (const bad of [null, {}, { body: {} }, { ...clone(r1), alg: "HS256" }, { ...clone(r1), body: { ...r1.body, decision: "maybe" } }]) {
      assert.deepEqual(verifyReceipt(bad, { keys: [key] }).problems, ["malformed"]);
    }
  });

  it("checks the subject when the original request is given", () => {
    const subject = golden.subject as ToolCallSubject;
    assert.equal(verifyReceipt(r1, { keys: [key], subject }).ok, true);

    const otherCommand = { ...subject, tool_input: { command: "git push --force origin release" } };
    assert.deepEqual(verifyReceipt(r1, { keys: [key], subject: otherCommand }).problems, ["subject_mismatch"]);

    const replayed = { ...subject, client_nonce: "99999999-9999-4999-8999-999999999999" };
    assert.deepEqual(verifyReceipt(r1, { keys: [key], subject: replayed }).problems, ["subject_mismatch"]);
  });
});

describe("verifyChain", () => {
  it("a complete chain has no gaps or breaks", () => {
    const [report] = verifyChain([r2, r1]);
    assert.equal(report.count, 2);
    assert.equal(report.from_genesis, true);
    assert.deepEqual(report.gaps, []);
    assert.deepEqual(report.breaks, []);
  });

  it("an edited earlier receipt breaks the next link", () => {
    const edited = clone(r1);
    edited.body.decision = "denied";
    const [report] = verifyChain([edited, r2]);
    assert.deepEqual(report.breaks, [{ seq: 2, reason: "prev_digest_mismatch" }]);
  });

  it("a deleted receipt shows as a gap in seq", () => {
    const signer = signerFromSeed(golden.key.seed, golden.key.kid);
    const r3 = signBody({ ...r2.body, seq: 3, prev_receipt_digest: bodyDigest(r2.body) }, signer);
    const [report] = verifyChain([r1, r3]);
    assert.deepEqual(report.gaps, [{ after: 1, before: 3 }]);
    assert.deepEqual(report.breaks, []);
  });

  it("a partial export starts mid-chain without a break", () => {
    const [report] = verifyChain([r2]);
    assert.equal(report.from_genesis, false);
    assert.deepEqual(report.breaks, []);
  });

  it("flags a duplicate seq and a genesis receipt with a prev digest", () => {
    assert.deepEqual(verifyChain([r1, clone(r1)])[0].breaks, [{ seq: 1, reason: "duplicate_seq" }]);
    const odd = clone(r1);
    odd.body.prev_receipt_digest = golden.receipts[1].body_digest;
    assert.deepEqual(verifyChain([odd])[0].breaks, [{ seq: 1, reason: "genesis_has_prev" }]);
  });

  it("compares against a saved chain head", () => {
    const head = golden.chain_head.body;
    assert.deepEqual(verifyChain([r1, r2], [head])[0].head, { seq: 2, digest_matches: true, missing_tail: false });
    assert.deepEqual(verifyChain([r1], [head])[0].head, { seq: 2, digest_matches: null, missing_tail: true });
    const rewritten = clone(r2);
    rewritten.body.decision = "approved";
    assert.equal(verifyChain([r1, rewritten], [head])[0].head?.digest_matches, false);
  });
});

describe("ids and keys", () => {
  it("receipt ids are rcpt_ plus 26 Crockford base32 characters", () => {
    const id = newReceiptId();
    assert.match(id, /^rcpt_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(id, newReceiptId());
    assert.equal(shortReceiptId("rcpt_7Q2FABCDEFGHJKMNPQRSTVWXYZ0"), "rcpt_7Q2FABCD");
  });

  it("chains are per operator, falling back to the API key", () => {
    assert.equal(chainIdFor("op-uuid", "key-uuid"), "op_op-uuid");
    assert.equal(chainIdFor(null, "key-uuid"), "key_key-uuid");
    assert.throws(() => chainIdFor(null, null));
  });

  it("maps DB status to receipt decision and back", () => {
    assert.equal(receiptDecision("timeout"), "timed_out");
    assert.equal(receiptDecision("approved"), "approved");
    assert.throws(() => receiptDecision("pending"));
    assert.equal(responseDecision("timed_out"), "timeout");
  });

  it("a generated seed signs and verifies, a bad seed is refused", () => {
    const { seed, publicKey } = generateSigningSeed();
    assert.equal(publicKeyFromSeed(seed), publicKey);
    const signer = signerFromSeed(seed, "k1");
    const env = signBody({ hello: "world", issued_at: "2026-10-05T00:00:00.000Z" }, signer);
    const k: ReceiptKey = { kid: "k1", alg: "Ed25519", public_key: publicKey, not_before: "2026-01-01T00:00:00.000Z", not_after: null };
    assert.equal(verifySigned(env, [k]).ok, true);
    assert.throws(() => signerFromSeed("dG9vLXNob3J0", "k1"));
  });
});
