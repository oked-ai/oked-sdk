# Signed approval receipts

Every decision OKed records on an agent action comes with a signed receipt:
who decided, how they were verified, what exact action they decided on, and
when. Anyone can check a receipt offline with OKed's public key, without
trusting OKed's database.

A receipt is evidence that supports change-authorization controls (for
example SOC 2 CC8.1, segregation of duties, EU AI Act Article 14 human
oversight). It does not by itself make anyone compliant.

## What a receipt proves

- **This decision was recorded by OKed.** The receipt is signed with OKed's
  Ed25519 key. One changed byte breaks the signature.
- **It is about this exact action.** `subject_digest` is a SHA-256 over the
  action exactly as the agent's integration sent it: the tool name, the
  description and the raw tool input (the full command, the SQL, the email
  body), not the shortened text on the approval card. A receipt for one
  command never verifies against another.
- **It was issued for this request, once.** The client sends a random nonce
  with every request and it is part of the subject, so a receipt cannot be
  replayed for a later, identical action.
- **What the approver was shown.** `display_digest` is a SHA-256 of the card
  that was rendered (title, target, body and so on).
- **Who decided, and how honestly that is known.** `decider.kind` is `human`,
  `rule` or `system`, and `decider.assurance` says how the human was
  verified: `channel` (a linked Telegram account, a signed-in dashboard
  session, or the signed-in OKed iPhone app), `device_verified` (the iPhone
  app checked Face ID or the device passcode right before the decision), or
  `passkey` once that ships. Rules and timeouts are
  labeled as such and never look like human approvals.
- **Nothing was deleted or edited in between.** Receipts form a hash chain
  per operator: each one carries the digest of the one before it, and `seq`
  counts up from 1 with no gaps. A deleted receipt shows as a gap; an edited
  one breaks the next link.

## What a receipt does not prove

- **That a specific person was present.** `channel` assurance proves the
  Telegram account, the dashboard session or the signed-in phone, not the
  person holding it. `device_verified` comes closer: the phone checked Face ID
  or its passcode, but the phone itself reports that check. Passkey step-up
  (assurance `passkey`) is planned.
- **That the action then ran, or what it returned.** A receipt covers the
  decision. The integration enforces it: by default (since 0.6.0) an approved
  action only runs once a valid receipt for it exists.
- **Independence from OKed itself.** OKed holds the signing key, so OKed
  alone could in principle rewrite a chain and sign it again. Two things make
  that detectable today: your own copy of the receipts (the Claude Code hook
  keeps one in `~/.oked/receipts.jsonl`) and signed chain heads you save
  (`GET /api/v1/receipts/head`). Publishing chain heads to an external log
  (anchoring) will close it fully, and is planned.

## Format (v1)

A receipt is a JSON envelope:

```json
{
  "body": {
    "v": 1,
    "receipt_id": "rcpt_PZSTTS628GBCJRYJWRQGCPNC5R",
    "chain_id": "op_11111111-1111-4111-8111-111111111111",
    "seq": 42,
    "issued_at": "2026-10-05T09:31:02.000Z",
    "issuer": "api.oked.ai",
    "operator_id": "11111111-1111-4111-8111-111111111111",
    "request_id": "22222222-2222-4222-8222-222222222222",
    "subject_type": "tool_call",
    "subject_digest": "sha256:…",
    "display_digest": "sha256:…",
    "summary": "Force push",
    "risk_tier": "high_stakes",
    "decision": "approved",
    "decided_at": "2026-10-05T09:31:01.000Z",
    "decider": {
      "kind": "human",
      "operator_id": "11111111-1111-4111-8111-111111111111",
      "display_name": "Oren",
      "assurance": "channel",
      "channel": "telegram",
      "rule_id": null,
      "reason": null
    },
    "requester": {
      "operator_id": "11111111-1111-4111-8111-111111111111",
      "api_key_id": "44444444-4444-4444-8444-444444444444",
      "client": "@oked/claude-code@0.5.0"
    },
    "same_person": true,
    "prev_receipt_digest": "sha256:…"
  },
  "alg": "Ed25519",
  "kid": "oked-2026-10",
  "sig": "<base64url Ed25519 signature over JCS(body)>"
}
```

| Field | Meaning |
|---|---|
| `decision` | `approved`, `denied` or `timed_out` (nobody answered in time, so OKed denied it). |
| `decider.kind` | `human`, `rule` (a rule the operator wrote; `rule_id` set) or `system` (`reason`: `timeout`, or `classified_safe` when OKed's classifier found the action low risk and allowed it without asking). |
| `decider.assurance` | `none`, `channel`, `device_verified` or `passkey`. |
| `decider.channel` | Where a human decided: `telegram`, `dashboard` or `mobile` (the OKed iPhone app). `null` for rules and the system. |
| `same_person` | True when a human approved an action from an agent they run themselves. Shown, not blocked. |
| `summary` | The rendered title, or `null` when the operator turned summaries off (titles can contain file names or email addresses). |
| `chain_id` | `op_<operator id>`, or `key_<API key id>` for a key with no operator. |
| `prev_receipt_digest` | `body_digest` of the previous receipt in the chain; `null` for `seq` 1. |

Digests are `sha256:` followed by 64 lowercase hex characters.

- **Canonical form.** Bodies are serialized with RFC 8785 (JCS): object keys
  sorted by UTF-16 code unit, no whitespace, ECMAScript number and string
  serialization.
- **Signature.** `sig` is Ed25519 over the UTF-8 bytes of `JCS(body)`,
  base64url without padding.
- **`body_digest`** is `sha256(JCS(body))`.
- **`subject_digest`** is `sha256(JCS(subject_core))`, where `subject_core`
  for a hook or SDK request is:

  ```json
  {
    "type": "tool_call",
    "operator_id": "<operator id or null>",
    "request_id": "<request id>",
    "source": "claude-code",
    "action": "Bash",
    "description": "Force-push to main",
    "tool_input": { "command": "git push --force origin main" },
    "client_nonce": "<random per request>"
  }
  ```

  Values are JSON as the backend received them (missing becomes `null`).

- **`display_digest`** is `sha256(JCS(shown))` over `classifier_version`,
  `tier`, `title`, `target`, `annotation`, `subline`, `body` and `footnote` of
  the rendered card.

Receipts are stored append-only: the database rejects UPDATE, DELETE and
TRUNCATE on them, and they are kept even if the request row is deleted.

## Keys

OKed publishes every key that ever signed receipts at
<https://api.oked.ai/.well-known/oked-receipt-keys.json>:

```json
{ "keys": [{ "kid": "oked-2026-10", "alg": "Ed25519", "public_key": "<base64url raw 32 bytes>", "not_before": "…", "not_after": null }] }
```

- **Validity window.** A receipt is valid only if its `issued_at` falls
  inside its key's window.
- **Rotation.** Retired keys stay listed with a `not_after`. A new key is
  introduced at least every 12 months, or at once on a suspected leak.

## Verifying

From an export (dashboard, Recent, "Export receipts"), a `.jsonl` file or a
single receipt:

```bash
npx @oked/verify oked-receipts-2026-09-01-to-2026-10-01.zip
```

It checks every signature and key window, the chain (gaps, broken links,
signed chain heads) and, with `--subject <file>`, that one receipt is for
exactly the original request. Exit code 0 means everything verified.

- **Your own copy.** `oked receipts verify` (from `@oked/claude-code`) checks
  `~/.oked/receipts.jsonl`. Gaps in `seq` are expected there, because other
  devices and agents share the operator's chain.
- **As a library.** Use `@oked/receipt-core` (`verifyReceipt`,
  `verifyChain`) or `@oked/verify` (`readBundle`, `verifyBundle`).
- **By hand.** Fetch the key set, compute `JCS(body)`, and check `sig` with
  any Ed25519 implementation.

## Enforcement in the SDK

`@oked/sdk` verifies the receipt on every decision before an integration acts
on it:

- The signature must be by an OKed key whose window covers `issued_at`.
- `request_id` must match the request.
- The decision must be the same one the backend returned.
- `subject_digest` must match the exact action and nonce the SDK sent.

A receipt that fails any check is a deny (`OKedReceiptError`), never a
degraded-mode allow.

| Setting | Effect |
|---|---|
| `requireReceipt` (env `OKED_REQUIRE_RECEIPT`) | An approval with no receipt also denies. On by default since 0.6.0 (it was off in 0.5.0). Set `false` / `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts. A deny or a timeout without a receipt stays a deny. |
| `receiptKeysUrl` (env `OKED_RECEIPT_KEYS_URL`) | Where to fetch a key the SDK has not seen. Default is OKed's published set, independent of `backendUrl`; https only, except loopback for local development. |
| `receiptKeys` | Verify with exactly these keys and never fetch (self-hosted backends, tests). |

## Signed chain heads

`GET /api/v1/receipts/head` (with your API key) returns the latest `seq` and
digest of your chain, signed like a receipt. Save them from time to time.
Later, `npx @oked/verify` compares an export with the heads in it, and you
can compare it with the ones you kept.
