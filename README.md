# @oked/sdk

Human approval SDK for AI agents.

`@oked/sdk` lets an application send sensitive actions to an OKed backend, wait for a human decision, and continue only when approved.

## Install

```bash
npm install @oked/sdk
```

## Quick Start

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

## Environment

- `OKED_API_KEY`: required unless passed in code
- `OKED_BACKEND_URL`: optional, defaults to the hosted OKed backend

## API

### `new OKedClient(config?)`

Configuration:

- `apiKey: string`
- `backendUrl: string`
- `timeout: number`

### `approve(request)`

Request:

- `action: string`
- `description: string`
- `tier: "safe" | "warning" | "normal" | "high_stakes"`
- `tool_input?: unknown`
- `session_id?: string`
- `cwd?: string`

Response:

- `approved: boolean`
- `approval_id: string`
- `decision: "approved" | "denied" | "timeout"`

### `ping()`

Checks backend health and returns `true` when reachable.

## Exports

- `OKedClient`
- `classify`
- `describe`
- types from `types.ts`

## Development

```bash
npm install
npm run build
```

## License

MIT
