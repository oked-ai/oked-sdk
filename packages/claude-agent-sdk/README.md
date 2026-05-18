# @oked/claude-agent-sdk

OKed for the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
A ready-made `PreToolUse` hook callback — sensitive tool calls freeze the
agent and wait for a human approval (push to your phone) before running.

> Building with the **Claude Code CLI** instead? Use
> [`@oked/claude-code`](../claude-code) (`oked init`, zero code).

## Why this exists

The Claude Agent SDK does **not** read `.claude/settings.json` hooks by
default — hooks are passed programmatically via `options.hooks`. So unlike
the Claude Code CLI there's no zero-code install: you wire OKed's hook into
your agent's options yourself. (If you *do* load project settings via
`settingSources: ["project"]`, the `@oked/claude-code` hook would also fire —
this package is for the common programmatic case.)

## Install

```sh
npm install @oked/claude-agent-sdk
```

`@anthropic-ai/claude-agent-sdk` is an optional peer dependency — you already
have it if you're building an agent.

## Use

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { okedHooks } from "@oked/claude-agent-sdk";

for await (const message of query({
  prompt: "…",
  options: { hooks: okedHooks() },
})) {
  // …
}
```

Or wire the callback yourself for full control over matchers/timeout:

```ts
import { okedPreToolUseHook } from "@oked/claude-agent-sdk";

const options = {
  hooks: {
    PreToolUse: [{ hooks: [okedPreToolUseHook] }],
  },
};
```

## Auth

Bring your own API key (this package has no pairing CLI):

- `OKED_API_KEY=ok_…` environment variable, or
- `~/.oked/config.json` (`{ "apiKey": "ok_…" }`)

Create a key from the OKed dashboard. Optionally set `OKED_BACKEND_URL` to
target a non-default backend.

## Behavior

Same tier model and fail-safe semantics as the other OKed integrations:

| Tier | What happens |
|------|--------------|
| `safe` | Allow immediately, no network call |
| `warning` | Allow, log to stderr only, no network call |
| `review` / `high_stakes` | Request approval; **Approve** → run, otherwise the tool call is denied with a reason |

Failure handling: missing API key → defer to the agent's built-in
permission flow (`ask`); invalid key → deny; backend unreachable → degrade
per tier (`degradedDecision` — high-stakes / strict fail-closed deny, others
may proceed); any unexpected error → deny. Never proceeds when in doubt.

## Attribution note

This package authenticates with an API key (no device pairing), so its
approvals are recorded under the generic `sdk` source. First-class
`claude-agent-sdk` attribution in the dashboard requires the upcoming
per-request `source` on `@oked/sdk` (tracked separately).

## License

MIT
