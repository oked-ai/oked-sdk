import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { bodyDigest, signBody, signerFromSeed, type ReceiptKey, type SignedReceipt } from "@oked/receipt-core";
import { readBundle, verifyBundle, unzip } from "../src/index.js";

const golden = JSON.parse(
  readFileSync(new URL("../../receipt-core/test/vectors/receipt-v1.json", import.meta.url), "utf8"),
);
const key: ReceiptKey = {
  kid: golden.key.kid,
  alg: "Ed25519",
  public_key: golden.key.public_key,
  not_before: golden.key.not_before,
  not_after: null,
};
const [r1, r2] = golden.receipts.map((r: any) => r.envelope) as SignedReceipt[];
const dir = mkdtempSync(join(tmpdir(), "oked-verify-"));
const write = (name: string, data: string | Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};
const jsonl = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** A tiny zip writer for the test (one deflate entry, one stored). */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let i = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const method = i++ % 2 === 0 ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const bundleZip = (receipts: unknown[]) =>
  write(
    `bundle-${Math.random().toString(36).slice(2)}.zip`,
    zip({
      "receipts.jsonl": jsonl(receipts),
      "keys.json": JSON.stringify({ keys: [key] }),
      "chain-head.json": JSON.stringify([golden.chain_head]),
      "README.txt": "test",
    }),
  );

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
    encoding: "utf8",
  });

describe("@oked/verify", () => {
  it("an export bundle verifies end to end with its own keys and chain head", () => {
    const report = verifyBundle(readBundle(bundleZip([r1, r2])), [key]);
    assert.equal(report.ok, true);
    assert.equal(report.valid, 2);
    assert.deepEqual(report.byDecider, { human: 1, system: 1 });
    assert.deepEqual(report.byDecision, { approved: 1, timed_out: 1 });
    assert.equal(report.samePerson, 1);
    assert.deepEqual(report.chains[0].head, { seq: 2, digest_matches: true, missing_tail: false });
  });

  it("one changed byte fails that receipt", () => {
    const edited = JSON.stringify(r1).replace('"decision":"approved"', '"decision":"denied"');
    const report = verifyBundle(readBundle(write("edited.jsonl", edited + "\n" + JSON.stringify(r2) + "\n")), [key]);
    assert.equal(report.ok, false);
    assert.deepEqual(report.invalid, [{ receipt_id: r1.body.receipt_id, seq: 1, problems: ["bad_signature"] }]);
  });

  it("a deleted receipt shows as a gap in seq", () => {
    const signer = signerFromSeed(golden.key.seed, golden.key.kid);
    const r3 = signBody({ ...r2.body, receipt_id: "rcpt_C", seq: 3, prev_receipt_digest: bodyDigest(r2.body) }, signer);
    const report = verifyBundle(readBundle(write("gap.jsonl", jsonl([r1, r3]))), [key]);
    assert.deepEqual(report.chains[0].gaps, [{ after: 1, before: 3 }]);
  });

  it("checks one receipt against the original request", () => {
    const one = readBundle(write("one.json", JSON.stringify(r1)));
    assert.equal(verifyBundle(one, [key], golden.subject).subject?.matches, true);
    const changed = { ...golden.subject, tool_input: { ...golden.subject.tool_input, command: "git push --force origin release" } };
    const report = verifyBundle(one, [key], changed);
    assert.equal(report.subject?.matches, false);
    assert.equal(report.ok, false);
  });

  it("a chain head that disagrees with the receipts fails", () => {
    const signer = signerFromSeed(golden.key.seed, golden.key.kid);
    const lying = signBody({ ...golden.chain_head.body, digest: golden.receipts[0].body_digest }, signer);
    const path = write("lying.zip", zip({ "receipts.jsonl": jsonl([r1, r2]), "keys.json": JSON.stringify({ keys: [key] }), "chain-head.json": JSON.stringify([lying]) }));
    assert.equal(verifyBundle(readBundle(path), [key]).ok, false);
  });

  it("reads stored and deflated zip entries", () => {
    const files = unzip(zip({ a: "deflated", b: "stored" }));
    assert.equal(files.get("a")?.toString(), "deflated");
    assert.equal(files.get("b")?.toString(), "stored");
  });

  it("the CLI reports and exits 0 for a good bundle, 1 for a bad one", () => {
    const good = cli(bundleZip([r1, r2]));
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /2 receipts: 2 valid, 0 invalid/);
    assert.match(good.stdout, /decided by: 1 human, 1 system/);
    assert.match(good.stdout, /signed chain head \(seq 2\) matches/);
    assert.match(good.stdout, /^OK$/m);

    const edited = JSON.stringify(r2).replace('"timed_out"', '"approved"');
    const bad = cli(write("bad.jsonl", jsonl([r1]) + edited + "\n"), "--keys", write("keys.json", JSON.stringify({ keys: [key] })));
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /INVALID rcpt_0000000000000000000000000B seq 2: bad_signature/);
    assert.match(bad.stdout, /PROBLEMS FOUND/);
  });
});
