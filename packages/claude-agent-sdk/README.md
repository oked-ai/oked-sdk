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
may proceed); any unexpected error → deny. Set `OKED_STRICT_FAIL_CLOSED=1`
to deny every sensitive action during backend outages.

## Attribution

Approvals are attributed by the **API key's pairing record** — not a
per-request field. Pair a device with `client_type: "claude-agent-sdk"`
and that clientType plus the host/device name are bonded to the issued API
key (`device_codes` ↔ `api_keys`). Every approval made with that key is
then attributable to `claude-agent-sdk` in the dashboard, via the same
mechanism used for the other integrations.

This package ships no pairing CLI (callback-only, BYO key), so obtain a
`claude-agent-sdk`-typed key through your pairing flow. A key minted from
the dashboard "create key" UI has no device record and falls back to the
generic `sdk` bucket.

## License

MIT
