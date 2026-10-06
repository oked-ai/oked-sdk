import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./jcs.js";
import type { ReceiptKey, Signed } from "./types.js";

// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface ReceiptSigner {
  kid: string;
  /** base64url of the raw 32-byte public key, as published in the key set. */
  publicKey: string;
  sign(message: Uint8Array): string;
}

function decodeSeed(seed: string): Buffer {
  const raw = Buffer.from(seed.trim(), "base64url");
  if (raw.length !== 32) throw new Error("receipt signing key must be a base64url-encoded 32-byte Ed25519 seed");
  return raw;
}

function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return jwk.x;
}

/** A fresh signing key: the seed is the secret, the public key is published. */
export function generateSigningSeed(): { seed: string; publicKey: string } {
  const seed = randomBytes(32).toString("base64url");
  return { seed, publicKey: publicKeyFromSeed(seed) };
}

export function publicKeyFromSeed(seed: string): string {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, decodeSeed(seed)]), format: "der", type: "pkcs8" });
  return rawPublicKey(createPublicKey(priv));
}

/** A signer for the base64url seed held in OKED_RECEIPT_SIGNING_KEY. */
export function signerFromSeed(seed: string, kid: string): ReceiptSigner {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, decodeSeed(seed)]), format: "der", type: "pkcs8" });
  return {
    kid,
    publicKey: rawPublicKey(createPublicKey(priv)),
    sign: (message) => sign(null, message, priv).toString("base64url"),
  };
}

/** Sign a body: Ed25519 over the UTF-8 bytes of JCS(body). */
export function signBody<B>(body: B, signer: ReceiptSigner): Signed<B> {
  const message = Buffer.from(canonicalize(body), "utf8");
  return { body, alg: "Ed25519", kid: signer.kid, sig: signer.sign(message) };
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

/** True when `envelope.sig` is a valid signature by `key` over JCS(envelope.body). */
export function signatureValid(envelope: Signed<unknown>, key: Pick<ReceiptKey, "public_key">): boolean {
  try {
    const message = Buffer.from(canonicalize(envelope.body), "utf8");
    return verify(null, message, publicKeyObject(key.public_key), Buffer.from(envelope.sig, "base64url"));
  } catch {
    return false;
  }
}
