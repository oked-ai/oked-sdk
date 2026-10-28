# @oked/verify

[![npm version](https://img.shields.io/npm/v/@oked/verify.svg)](https://www.npmjs.com/package/@oked/verify)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/verify.svg)](./LICENSE)

Verify OKed signed approval receipts offline. For auditors and anyone who needs to check what an agent was allowed to do without trusting OKed's database.

You can also paste one receipt in the browser at [oked.ai/docs/#verify](https://oked.ai/docs/#verify). That check stays in the browser. Nothing is uploaded.

```bash
npx @oked/verify oked-receipts-2026-09-01-to-2026-10-01.zip
```

Sample of the text report (the counts below are not a real export):

```
  412 receipts: 412 valid, 0 invalid
  decided by: 377 human, 21 rule, 14 system (3 where the approver also ran the agent)
  outcomes:   389 approved, 9 denied, 14 timed out
  chain op_7f3c...: 412 receipts, from seq 1 to 412
    signed chain head (seq 412) matches
OK
```

It checks:

- **Every signature** (Ed25519 over the RFC 8785 canonical body) against OKed's public keys, and that the key was valid when the receipt was issued.
- **The hash chain**: each receipt names the digest of the one before it, so a deleted receipt shows as a gap in `seq` and an edited one breaks the next link.
- **Signed chain heads** in the bundle (or ones you saved earlier) agree with the receipts.
- **The exact action**, for one receipt, when you pass the original request with `--subject`.

Inputs: an export bundle from the OKed dashboard (`.zip`), a `.jsonl` file (one receipt per line, such as `~/.oked/receipts.jsonl`), or a `.json` file with one receipt or an array. Keys come from the bundle's `keys.json`, from `--keys <file>`, or from https://api.oked.ai/.well-known/oked-receipt-keys.json.

The published binary name is `oked-verify` (`npx @oked/verify` runs it). Node.js 18 or newer.

| Option | |
|---|---|
| `--keys <keys.json>` | Verify with these keys |
| `--keys-url <url>` | Fetch keys from this URL (https, or loopback http) |
| `--subject <file>` | The original request (`subject_core` JSON) for one receipt |
| `--json` | Print the full report as JSON |

Exit code 0 when everything verifies, 1 otherwise. `--help` prints the usage text. With no file argument it exits 1.

As a library:

```ts
import { readBundle, verifyBundle, fetchKeys } from "@oked/verify";

const bundle = readBundle("export.zip");
const report = verifyBundle(bundle, bundle.keys ?? (await fetchKeys()));
```

What a receipt proves, and what it does not: [docs/receipts.md](https://github.com/oked-ai/oked-sdk/blob/main/docs/receipts.md). [Apache-2.0](./LICENSE).
