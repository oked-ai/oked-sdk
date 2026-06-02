# @oked/sdk

[![npm version](https://img.shields.io/npm/v/@oked/sdk.svg)](https://www.npmjs.com/package/@oked/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Types: included](https://img.shields.io/npm/types/@oked/sdk.svg)](./dist/index.d.ts)

Core library - programmatic approval API for AI agents. Sends sensitive actions to the OKed backend, waits for a human decision, and resolves only when the user approves or denies.

Use this package directly from any Node.js agent (OpenAI SDK, LangChain, custom). For drop-in integrations, see [`@oked/claude-code`](../claude-code) or [`@oked/openclaw`](../openclaw).

## Install

```bash
npm install @oked/sdk
```

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

## Configuration

Pass to `new OKedClient(config)`:

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `OKED_API_KEY` env | Your OKed API key. Required. |
| `backendUrl` | `string` | `https://api.oked.ai` | Override the OKed backend URL. |
| `timeout` | `number` | `300000` | Per-approval timeout in ms. |
| `strictFailClosed` | `boolean` | `false` | When true, backend outages deny every tier. When false, outages deny only `high_stakes` and allow lower tiers. |

## API

### `approve(request)`

Request an approval for a sensitive action. Resolves when the user responds, the request times out, or the backend denies.

Request fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `string` | yes | Short action identifier (e.g. `"deploy"`, `"send_email"`). |
| `description` | `string` | yes | Human-readable summary shown in the approval UI. |
| `tier` | `"safe" \| "warning" \| "review" \| "high_stakes"` | yes | Risk tier. Use `classify()` if unsure. |
| `tool_input` | `unknown` | no | Raw tool arguments, included in the audit log. |
| `session_id` | `string` | no | Groups related approvals under one session. |
| `cwd` | `string` | no | Working directory, shown in the UI for context. |

Response fields:

| Field | Type | Description |
|---|---|---|
| `approved` | `boolean` | `true` only when the user approved. |
| `approval_id` | `string` | Opaque id for logs / audit. |
| `decision` | `"approved" \| "denied" \| "timeout"` | Exact outcome. |

### `ping()`

Returns `true` when the backend is reachable. Use for startup health checks.

### Helpers

- `classify(input)` - classifies a shell command or tool call into a risk tier.
- `describe(input)` - generates a human-readable description for the approval UI.

Full type definitions ship with the package (`dist/index.d.ts`).

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | yes, unless passed in code | Your OKed API key. |
| `OKED_BACKEND_URL` | no | Override the hosted backend URL. |
| `OKED_STRICT_FAIL_CLOSED` | no | Set to `1` or `true` to deny every sensitive action when the backend is unreachable. |

## Degraded-mode behavior

Explicit user denials return `{ approved: false }` and should always be treated as final. Invalid API keys throw `OKedAuthError` and should deny. If the backend is unreachable, `OKedBackendUnreachableError` lets integrations apply degraded mode: `high_stakes` denies, while lower tiers may proceed unless `strictFailClosed` is enabled. Unexpected errors should be treated as deny.

## Development

```bash
npm install
npm run build
```

## License

[MIT](./LICENSE)
