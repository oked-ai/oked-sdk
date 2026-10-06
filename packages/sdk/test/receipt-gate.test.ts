import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSigningSeed,
  signerFromSeed,
  signBody,
  subjectDigest,
  jsonValue,
  type ReceiptBody,
  type ReceiptKey,
} from "@oked/receipt-core";

// Isolate ~/.oked (key cache) before the SDK computes its paths.
const home = mkdtempSync(join(tmpdir(), "oked-receipt-gate-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { OKedClient, OKedReceiptError, keysUrlAllowed } = await import("../src/index.js");

const { seed, publicKey } = generateSigningSeed();
const signer = signerFromSeed(seed, "gate-test");
const key: ReceiptKey = { kid: "gate-test", alg: "Ed25519", public_key: publicKey, not_before: "2026-01-01T00:00:00.000Z", not_after: null };

type Mode = "valid" | "tamper" | "other-action" | "replay" | "none" | "decision-mismatch";

describe("approve() receipt gate", () => {
  let server: Server;
  let port = 0;
  let mode: Mode = "valid";
  let lastValid: unknown = null;
  let keyFetches = 0;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/.well-known/oked-receipt-keys.json") {
        keyFetches++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [key] }));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const sent = JSON.parse(raw);
        const requestId = `req-${Math.random().toString(36).slice(2)}`;
        // What the backend hashes: the action exactly as received.
        const toolInput = mode === "other-action" ? { command: "rm -rf /" } : sent.metadata?.tool_input;
        const body: ReceiptBody = {
          v: 1,
          receipt_id: "rcpt_TEST",
          chain_id: "key_test",
          seq: 1,
          issued_at: new Date().toISOString(),
          issuer: "test",
          operator_id: null,
          request_id: requestId,
          subject_type: "tool_call",
          subject_digest: subjectDigest({
            type: "tool_call",
            operator_id: null,
            request_id: requestId,
            source: sent.metadata?.source || "sdk",
            action: sent.action,
            description: jsonValue(sent.description),
            tool_input: jsonValue(toolInput),
            client_nonce: sent.nonce ?? null,
          }),
          display_digest: null,
          summary: "probe",
          risk_tier: "review",
          decision: mode === "decision-mismatch" ? "denied" : "approved",
          decided_at: new Date().toISOString(),
          decider: { kind: "human", operator_id: null, display_name: "T", assurance: "channel", channel: "dashboard", rule_id: null, reason: null },
          requester: { operator_id: null, api_key_id: null, client: sent.client ?? null },
          same_person: false,
          prev_receipt_digest: null,
        };
        let receipt: any = signBody(body, signer);
        let approvalId = requestId;
        if (mode === "tamper") receipt = { ...receipt, body: { ...receipt.body, summary: "something else" } };
        if (mode === "replay" && lastValid) {
          receipt = lastValid;
          approvalId = (lastValid as any).body.request_id;
        }
        if (mode === "valid") lastValid = receipt;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            approval_id: approvalId,
            decision: "approved",
            status: "approved",
            ...(mode === "none" ? {} : { receipt }),
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  after(() => server.close());
  beforeEach(() => delete process.env.OKED_REQUIRE_RECEIPT);

  const client = (extra: Record<string, unknown> = {}) =>
    new OKedClient({ apiKey: "k", backendUrl: `http://127.0.0.1:${port}`, timeout: 5000, receiptKeys: [key], ...extra });
  const ask = (c: InstanceType<typeof OKedClient>) =>
    c.approve({ action: "Bash", description: "push", tier: "high_stakes", tool_input: { command: "git push --force" } });

  it("a valid receipt for the exact action is returned with the approval", async () => {
    mode = "valid";
    const r = await ask(client({ client: "@oked/test@1.0.0", source: "test" }));
    assert.equal(r.approved, true);
    assert.equal(r.receipt?.body.requester.client, "@oked/test@1.0.0");
  });

  it("one changed byte in the receipt denies", async () => {
    mode = "tamper";
    await assert.rejects(() => ask(client()), (e: any) => e instanceof OKedReceiptError && e.problems.includes("bad_signature"));
  });

  it("a receipt signed for a different command denies", async () => {
    mode = "other-action";
    await assert.rejects(() => ask(client()), (e: any) => e instanceof OKedReceiptError && e.problems.includes("subject_mismatch"));
  });

  it("an earlier valid receipt replayed for an identical action denies", async () => {
    mode = "valid";
    await ask(client());
    mode = "replay";
    await assert.rejects(() => ask(client()), (e: any) => e instanceof OKedReceiptError && e.problems.includes("subject_mismatch"));
  });

  it("a receipt for another decision denies", async () => {
    mode = "decision-mismatch";
    await assert.rejects(() => ask(client()), (e: any) => e instanceof OKedReceiptError && e.problems.includes("decision_mismatch"));
  });

  it("no receipt: allowed while requireReceipt is off (0.4.0 default)", async () => {
    mode = "none";
    const r = await ask(client());
    assert.equal(r.approved, true);
    assert.equal(r.receipt, undefined);
  });

  it("no receipt with requireReceipt on: the decision becomes a deny", async () => {
    mode = "none";
    await assert.rejects(() => ask(client({ requireReceipt: true })), OKedReceiptError);
    process.env.OKED_REQUIRE_RECEIPT = "1";
    await assert.rejects(() => ask(client()), OKedReceiptError);
  });

  it("fetches an unknown kid once from the keys URL, then uses the disk cache", async () => {
    mode = "valid";
    const keysUrl = `http://127.0.0.1:${port}/.well-known/oked-receipt-keys.json`;
    const c = () => new OKedClient({ apiKey: "k", backendUrl: `http://127.0.0.1:${port}`, timeout: 5000, receiptKeysUrl: keysUrl });
    const before = keyFetches;
    assert.equal((await ask(c())).approved, true);
    assert.equal((await ask(c())).approved, true);
    assert.equal(keyFetches - before, 1);
  });

  it("only accepts keys over TLS, or from this machine", () => {
    assert.equal(keysUrlAllowed("https://api.oked.ai/.well-known/oked-receipt-keys.json"), true);
    assert.equal(keysUrlAllowed("http://127.0.0.1:3000/x"), true);
    assert.equal(keysUrlAllowed("http://localhost:3000/x"), true);
    assert.equal(keysUrlAllowed("http://evil.example/keys.json"), false);
    assert.equal(keysUrlAllowed("not a url"), false);
  });
});
