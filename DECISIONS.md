# Decisions

Where the code and the PRD "Signed Approval Receipts" (Oct 5, 2026) disagree, the
code wins and the conflict is written down here. The backend's side is in
oked-app's DECISIONS.md. Newest first.

## Approval trail (October 2026)

**The "How it got here" trail is an optional upgrade, not built now.** The design "OKed
Approval Trail" adds the steps before an action to the phone card. A prototype on 170
real cards (Oct 2026) showed it can be built: the Claude Code hook gets
`transcript_path`, `tool_use_id` and `prompt_id`. Three parts helped: who started the
run (a person or a scheduled task), what a short prompt like "do it" answered, and the
agent's words, marked "Not checked by OKed". The step list did not help (58% of steps
read "Run command"; median 14 steps). The check "Traces back to your request" gave
false confidence. The trail also sends prompts and the agent's words off the Mac for
the first time, so it needs data limits, local redaction, an opt-in setting and a
retention time first. That work is too large for the value now.

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

**`requireReceipt` was off by default in 0.5.0 and is on from 0.6.0.** As the PRD says. An
invalid receipt always denies. A missing receipt denies only an approval: a deny or a
timeout without one is a deny already, and keeps its own message (the backend's
long-poll error path answers `timeout` with no receipt). The PRD says a missing receipt
"turns any decision into a deny"; the outcome is the same.

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
