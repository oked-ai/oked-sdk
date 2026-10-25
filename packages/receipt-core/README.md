# @oked/receipt-core

The format and the cryptography of OKed signed approval receipts, shared by the
OKed backend (which signs), `@oked/sdk` (which verifies before an action runs)
and `@oked/verify` (which auditors run). One implementation, so all three
compute the same bytes and the same digests.

A receipt is a JSON body signed with Ed25519 over its RFC 8785 canonical form
(JCS). It proves who decided on an agent action, how they were verified, what
exact action they decided on, and when. See
[docs/receipts.md](https://github.com/oked-ai/oked-sdk/blob/main/docs/receipts.md)
for the format, what a receipt proves and what it does not.

```ts
import { verifyReceipt, verifyChain } from "@oked/receipt-core";

const keys = await (await fetch("https://api.oked.ai/.well-known/oked-receipt-keys.json")).json();
const check = verifyReceipt(receipt, { keys });
// { ok: true, problems: [] } or e.g. { ok: false, problems: ["bad_signature"] }
```

| Export | What it does |
|---|---|
| `canonicalize(value)` | RFC 8785 JCS. Throws on values JSON cannot carry. |
| `jsonValue(value)` | The value as the other side of a JSON request sees it (undefined becomes null). |
| `subjectDigest(subject)` | `sha256:` digest of what was authorized (`subject_core`). |
| `displayDigest(shown)` | `sha256:` digest of what the approver was shown. |
| `bodyDigest(body)` | A receipt body's digest; the next receipt's `prev_receipt_digest`. |
| `verifyReceipt(receipt, { keys, subject? })` | Shape, key window, signature and, given the original request, the subject digest. |
| `verifyChain(receipts, heads?)` | Seq gaps, broken `prev_receipt_digest` links, duplicates, and agreement with saved chain heads. |
| `signerFromSeed(seed, kid)`, `signBody(body, signer)` | Signing, for the issuer. |

Node 18+, ESM, no dependencies (uses `node:crypto`). Apache-2.0.
