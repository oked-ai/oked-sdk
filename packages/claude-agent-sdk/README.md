# @oked/claude-agent-sdk

[![npm version](https://img.shields.io/npm/v/@oked/claude-agent-sdk.svg)](https://www.npmjs.com/package/@oked/claude-agent-sdk)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/claude-agent-sdk.svg)](./LICENSE)

OKed for the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). A `PreToolUse` hook: sensitive tool calls wait for a person, in Telegram or on the [web dashboard](https://oked.ai/dashboard), before they run. The iPhone app is coming soon.

Building with the Claude Code CLI instead? Use [`@oked/claude-code`](../claude-code) (`oked init`, no code).

## Why this package

The Claude Agent SDK does not read `.claude/settings.json` hooks unless you opt in. Hooks are passed in `options.hooks`. There is no zero-code install: you wire OKed into the agent's options. If you do load project settings with `settingSources: ["project"]`, the `@oked/claude-code` hook would also fire. This package is the programmatic path.

## Install

```sh
npm install @oked/claude-agent-sdk
```

`@anthropic-ai/claude-agent-sdk` is an optional peer dependency (`>=0.1.0`). You already have it if you are building an agent. Node.js 18 or newer.

## Use

`okedHooks()` sets the hook timeout to 690 seconds, above the SDK's 630 second wait, so a timeout is a deny instead of the harness aborting the hook with no decision.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { okedHooks } from "@oked/claude-agent-sdk";

for await (const message of query({
  prompt: "...",
  options: { hooks: okedHooks() },
})) {
  // ...
}
```

Or wire the callback yourself. Set `timeout` above 630 seconds if you do.

```ts
import { okedPreToolUseHook } from "@oked/claude-agent-sdk";

const options = {
  hooks: {
    PreToolUse: [{ hooks: [okedPreToolUseHook], timeout: 690 }],
  },
};
```

## Auth

This package has no pairing command. Provide a key in either place:

- `OKED_API_KEY` in the environment, or
- `~/.oked/config.json` (`{ "apiKey": "ok_..." }`)

Create a key from the [dashboard](https://oked.ai/dashboard) after you [sign up](https://oked.ai/signup), or run `oked init --key-only` from [`@oked/claude-code`](../claude-code). That command pairs the key as client type `sdk`.

Each request sends `source: "claude-agent-sdk"` and `client: "@oked/claude-agent-sdk@<version>"`. Both are part of the receipt subject.

## Behavior

Same tiers and fail-safe rules as the other integrations:

| Tier | What happens |
|---|---|
| `safe` | Allow immediately, no approval request |
| `warning` | Allow, log to stderr, no approval request |
| `review` / `high_stakes` | Ask for approval. Approve and the tool runs. Otherwise it is denied, with a reason. |

Failure handling: no API key defers to the agent's own permission flow (`ask`). An invalid key denies. A receipt that does not verify denies. An unreachable backend uses the shared degraded rule: `high_stakes` denies, and lower tiers may proceed unless `OKED_STRICT_FAIL_CLOSED=1`, which denies every sensitive action during an outage. Any other unexpected error denies.

## License

[Apache-2.0](./LICENSE)
