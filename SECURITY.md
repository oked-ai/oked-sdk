# Security Policy

OKed is a human-in-the-loop authorization layer for AI agents, so we take the integrity of
these packages seriously. The `@oked/*` packages are published with npm provenance (built and
signed on GitHub Actions via OIDC trusted publishing). Verify the provenance panel on each
package's npm page before trusting a build.

## Supported versions

We support the **latest published minor** of each `@oked/*` package. All packages are released
in lockstep and share a version number. Older versions receive fixes only at our discretion.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

- Preferred: open a [private security advisory](https://github.com/oked-ai/oked-sdk/security/advisories/new)
  on this repository.
- Alternatively, email **contact@oked.ai** with details and reproduction steps.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation as quickly as
the severity warrants. We'll credit reporters who want acknowledgement once a fix is released.

## Approval receipts

Every decision carries a receipt signed with OKed's Ed25519 key (see
[docs/receipts.md](./docs/receipts.md)), and `@oked/sdk` verifies it before an
integration acts on the decision.

- **Key trust.** The SDK trusts keys pinned in the package, keys it cached in
  `~/.oked/receipt-keys.json`, and keys fetched from
  `https://api.oked.ai/.well-known/oked-receipt-keys.json`. It never derives
  the keys URL from `OKED_BACKEND_URL`, so pointing an agent at a lookalike
  backend does not make that backend's signatures trusted.
- **Overrides are for self-hosting and development.** `OKED_RECEIPT_KEYS_URL`
  (https only, or loopback), `receiptKeys` in code and `receiptKeysUrl` in
  `~/.oked/config.json` change which keys are trusted. Anything that can
  change those can also change the hook itself, so protect `~/.oked` and your
  agent's settings the way you protect the API key.
- **Fail closed.** A receipt that fails any check denies the action
  (`OKedReceiptError`), and so does a missing one when `requireReceipt` is on.
- **Honest limit.** OKed holds the signing key. Your own copy of receipts
  (`~/.oked/receipts.jsonl`) and signed chain heads you save are how you would
  detect OKed rewriting a chain.
