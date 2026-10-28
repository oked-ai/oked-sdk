# Security Policy

OKed is a human-in-the-loop approval layer for AI agents. The product security page, including what OKed stores and how to delete an account, is [oked.ai/security](https://oked.ai/security). This file is how to report a vulnerability in these packages, and how receipt verification is anchored.

Decisions are made in Telegram and on the web dashboard. The iPhone app is coming soon.

The `@oked/*` packages are published from this public repository with npm's OIDC trusted publishing. npm signed a SLSA provenance statement for every package in the 0.6.20 release. Check the provenance panel on each package's npm page before trusting a build.

## Supported versions

We support the latest published minor of each `@oked/*` package. All packages are released in lockstep and share a version number. Older versions receive fixes only at our discretion.

## Reporting a vulnerability

Please do not open a public GitHub issue for security problems.

- Preferred: open a [private security advisory](https://github.com/oked-ai/oked-sdk/security/advisories/new) on this repository.
- Email [contact@oked.ai](mailto:contact@oked.ai), the address on [oked.ai/security](https://oked.ai/security). You can also email orendor@gmail.com.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation as quickly as the severity warrants. We credit reporters who want acknowledgement once a fix is released.

## Approval receipts

Every decision carries a receipt signed with OKed's Ed25519 key (see [docs/receipts.md](./docs/receipts.md)). `@oked/sdk` verifies it before an integration acts on the decision. You can also check a receipt at [oked.ai/docs/#verify](https://oked.ai/docs/#verify) or with `npx @oked/verify`.

- **Key trust.** The SDK trusts keys pinned in the package, keys it cached in `~/.oked/receipt-keys.json`, and keys fetched from `https://api.oked.ai/.well-known/oked-receipt-keys.json`. It never derives the keys URL from `OKED_BACKEND_URL`, so pointing an agent at a lookalike backend does not make that backend's signatures trusted.
- **Overrides are for self-hosting and development.** `OKED_RECEIPT_KEYS_URL` (https only, or loopback), `receiptKeys` in code, and `receiptKeysUrl` in `~/.oked/config.json` change which keys are trusted. Anything that can change those can also change the hook itself, so protect `~/.oked` and your agent's settings the way you protect the API key.
- **Fail closed on a bad receipt.** A receipt that fails any check denies the action (`OKedReceiptError`). An approval with no receipt also denies (the default since 0.6.0). `OKED_REQUIRE_RECEIPT=0` turns that off for a backend that does not sign receipts.
- **Limit of the signature.** OKed holds the signing key. Your own copy of receipts (`~/.oked/receipts.jsonl`) and signed chain heads you save are how you would detect OKed rewriting a chain.
