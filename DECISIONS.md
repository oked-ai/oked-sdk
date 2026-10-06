# Decisions

Where the code and the PRD "Signed Approval Receipts" (Oct 5, 2026) disagree, the
code wins and the conflict is written down here. The backend's side is in
oked-app's DECISIONS.md. Newest first.

## Signed approval receipts (October 2026)

**A held request is a timeout, not an outage.** Node's fetch (undici) drops a response
whose headers have not arrived in 300s, whatever the AbortSignal, and Railway closes a
request after 5 minutes without bytes. Both reached the SDK as
`OKedBackendUnreachableError`, and degraded mode allowed review-tier actions nobody
approved. The SDK now returns `decision: "timeout"` for its own abort,
`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT` and a 504. Connect failures keep
their degraded behavior.

**SDK timeout 630s, not "match the backend".** PRD R0.4 says the timeouts should match
at 10 minutes. They must stay ordered backend < SDK < harness (#60), so the backend
waits 600s and `DEFAULT_APPROVAL_TIMEOUT_MS` is 630_000. Hook timeouts derive from it
(690s); existing 660s settings still clear 638s.

**`subject_core` covers the raw tool input and a client nonce.** The PRD hashes
`rawAction` + `rawFields`. `rawFields` is display text that `describe.ts` truncates,
and OpenClaw sends none, so the SDK sends a fresh `nonce` per request and the subject
is `{ type, operator_id, request_id, source, action, description, tool_input,
client_nonce }`. The SDK recomputes it from what it sent.

**`requireReceipt` is off by default in 0.5.0, the first release with receipts.** As the PRD says (on from 0.6.0). An
invalid receipt always denies; only a missing one is tolerated while it is off.

**Keys: pinned, then cached, then a fixed URL.** The PRD says keys are fetched once,
cached next to `~/.oked/config.json`, and new keys accepted only from the well-known URL
over TLS. That URL is fixed to `https://api.oked.ai/...` (not derived from
`OKED_BACKEND_URL`, so a lookalike backend cannot supply its own key), with
`OKED_RECEIPT_KEYS_URL` / `receiptKeys` for self-hosting and loopback http for local
development. `PINNED_RECEIPT_KEYS` holds the production key `oked-2026-10`.

**`source` and `client` are new request fields.** No client sent `metadata.source`
before, so old rows say `"sdk"`. The integrations now send `source` (`claude-code`,
`claude-agent-sdk`, `openclaw`) and `client` (`@oked/<package>@<version>`).

**`approval_id` is `string | null`.** It always was at runtime (server auto-allows);
the type now says so.
