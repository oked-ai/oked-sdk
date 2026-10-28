# @oked/sdk

[![npm version](https://img.shields.io/npm/v/@oked/sdk.svg)](https://www.npmjs.com/package/@oked/sdk)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/sdk.svg)](./LICENSE)

Programmatic approval API for AI agents. Send a sensitive action to the OKed backend, wait for a person, and continue only when they approve.

Use this package from any Node.js agent. For drop-in integrations, see [`@oked/claude-code`](../claude-code), [`@oked/claude-agent-sdk`](../claude-agent-sdk), and [`@oked/openclaw`](../openclaw).

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon and is not on the App Store. [Sign up](https://oked.ai/signup) to get an API key.

## Install

```bash
npm install @oked/sdk
```

Node.js 18 or newer.

## Quick start

```ts
import { OKedClient } from "@oked/sdk";

const oked = new OKedClient({
  apiKey: process.env.OKED_API_KEY,
});

const result = await oked.approve({
  action: "deploy",
  description: "Deploy release 2026.04.07 to production",
  tier: "high_stakes",
  session_id: "deploy-123",
  cwd: process.cwd(),
});

if (!result.approved) {
  throw new Error(`Blocked by OKed: ${result.decision}`);
}
```

The approval window is 10 minutes. The client waits 630 seconds (`630000` ms, `DEFAULT_APPROVAL_TIMEOUT_MS`), 30 seconds past that window, so the backend's `timeout` answer arrives before the client aborts. A timeout is a denial. If you raise `timeout`, raise the harness hook limit above it. Otherwise the process can be killed before the deny is written.

## Configuration

Pass any of these to `new OKedClient(config)`. Constructor values win over environment variables, which win over `~/.oked/config.json`.

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `OKED_API_KEY`, then the config file | OKed API key. Required for `approve`. |
| `backendUrl` | `string` | `https://api.oked.ai` | Backend URL. |
| `timeout` | `number` | `630000` | How long to wait for a decision, in milliseconds. See above. |
| `strictFailClosed` | `boolean` | `false` | When true, an unreachable backend denies every tier. When false, it denies only `high_stakes`. |
| `requireReceipt` | `boolean` | `true` | Deny an approval that arrives without a signed receipt. A receipt that is present but invalid always denies. Set `false` (env `OKED_REQUIRE_RECEIPT=0`) only for a backend that does not sign receipts. |
| `receiptKeysUrl` | `string` | `https://api.oked.ai/.well-known/oked-receipt-keys.json` | Where to fetch a receipt key the SDK has not seen. Independent of `backendUrl`. https only, except loopback. |
| `receiptKeys` | `ReceiptKey[]` | | Verify with exactly these keys and never fetch. For self-hosted backends and tests. |
| `rulesCacheTtlMs` | `number` | `300000` | How long the on-disk rules cache stays fresh. Env `OKED_RULES_CACHE_TTL` is in seconds. |
| `heartbeatIntervalMs` | `number` | `86400000` | Minimum gap between presence pings. Env `OKED_HEARTBEAT_INTERVAL` is in seconds. |
| `client` | `string` | | Your integration's name and version, for example `my-agent@1.2.0`. Recorded on the receipt. |
| `source` | `string` | `"sdk"` | Where the request came from. Part of the receipt subject. |

## API

### `approve(request)`

Ask for a decision. Resolves when the person responds, the request times out, or the backend returns an error as a thrown exception (see below).

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `string` | yes | Short action id, for example `"deploy"`. |
| `description` | `string` | yes | Text shown on the approval card. |
| `tier` | `"safe" \| "warning" \| "review" \| "high_stakes"` | yes | Risk tier. Use `classify()` if you are not sure. |
| `fields` | `Record<string, string>` | no | Card fields (title, target, body, and so on). |
| `tool_input` | `unknown` | no | Raw tool arguments. Included in the receipt subject. |
| `session_id` | `string` | no | Groups related approvals. |
| `cwd` | `string` | no | Working directory, shown for context. |

| Field | Type | Description |
|---|---|---|
| `approved` | `boolean` | `true` only when the person approved. |
| `approval_id` | `string \| null` | Id for logs. `null` when the backend created no request row. |
| `decision` | `"approved" \| "denied" \| "timeout"` | Outcome. |
| `receipt` | `SignedReceipt \| undefined` | Signed receipt, already verified against this request, this decision, and the exact action you sent. Absent for some denials and timeouts that carry no receipt. See [docs/receipts.md](../../docs/receipts.md). |

### `ping()`

Returns `true` when `GET {backendUrl}/health` succeeds within 3 seconds.

### `getRules()` and `heartbeat()`

`getRules()` returns the operator's rules, cached on disk. `heartbeat()` sends a throttled presence ping and never throws. Integrations call both. You do not need them to use `approve`.

### Helpers

- `classify(toolName, toolInput)` returns a risk tier for a tool call.
- `describe(toolName, toolInput, ctx?)` returns a one-line description.
- `describeFields(toolName, toolInput, ctx?)` returns the card fields.

Full type definitions ship in the package (`dist/index.d.ts`).

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | yes, unless passed in code or saved by `oked init` | OKed API key. |
| `OKED_BACKEND_URL` | no | Override the hosted backend URL. |
| `OKED_STRICT_FAIL_CLOSED` | no | `1` or `true` denies every sensitive action when the backend is unreachable. |
| `OKED_REQUIRE_RECEIPT` | no | `0` allows an approval that has no receipt. On by default. |
| `OKED_RECEIPT_KEYS_URL` | no | Where to fetch receipt keys. Default is OKed's published set. |
| `OKED_RULES_CACHE_TTL` | no | Rules cache TTL, in seconds. Default 300. |
| `OKED_HEARTBEAT_INTERVAL` | no | Minimum seconds between heartbeats. Default 86400. |

## Degraded-mode behavior

Explicit denials return `{ approved: false }` and are final. Invalid API keys throw `OKedAuthError`. A receipt that does not verify, or an approval with no receipt while `requireReceipt` is on, throws `OKedReceiptError`. A request the backend accepted and nobody answered returns `decision: "timeout"`, not an outage error. HTTP 429 throws `OKedTooManyPendingError` (too many approvals are already waiting). Other HTTP errors throw `OKedHttpError`.

If the backend is unreachable, `OKedBackendUnreachableError` is the outage signal. `high_stakes` denies. Lower tiers may proceed unless `strictFailClosed` is set. Treat anything else as a deny.

## Development

From the repo root:

```bash
npm install
npm run build
npm test
```

## License

[Apache-2.0](./LICENSE)
