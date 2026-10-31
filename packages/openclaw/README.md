# @oked/openclaw

[![npm version](https://img.shields.io/npm/v/@oked/openclaw.svg)](https://www.npmjs.com/package/@oked/openclaw)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/openclaw.svg)](./LICENSE)

OpenClaw plugin. A `before_tool_call` hook runs for every tool the host reports (built-in or registered by a skill), classifies it, and holds `review` and `high_stakes` calls until you approve in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon.

Optional peer dependency: `openclaw` >= 2026.4.20. A denial returns `{ block: true, blockReason }` instead of throwing. The plugin source says OpenClaw 2026.5.4 and later treat that return value as a veto and show the reason to the agent. An earlier host ignored the return and ran the tool.

## Install

OpenClaw installs plugins from ClawHub first:

```bash
openclaw plugins install @oked/openclaw
```

Pair this machine with [`@oked/openclaw-cli`](../openclaw-cli). The CLI needs the `openclaw` command on your PATH. It pairs this device (or reuses an existing API key), sets `minTier` (a terminal prompt when none is set), writes the entry into `~/.openclaw/openclaw.json`, and offers to restart the gateway.

```bash
npm install -g @oked/openclaw-cli
oked-openclaw init
```

If this package is not already installed, and there is no local checkout, `oked-openclaw init` runs `openclaw plugins install @oked/openclaw`. A checkout or a global npm copy is still linked with `openclaw plugins install --link`.

To wire the config by hand after the ClawHub install, edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["oked"],
    "entries": {
      "oked": {
        "enabled": true,
        "apiKey": "ok_...",
        "minTier": "review"
      }
    }
  }
}
```

Restart the OpenClaw gateway after a manual edit. [Sign up](https://oked.ai/signup) if you do not have a key yet. The same dashboard is also served at [app.oked.ai/dashboard](https://app.oked.ai/dashboard/).

## Configuration

Keys live under `plugins.entries.oked`. The plugin manifest sets `additionalProperties: false`, so unknown keys are rejected. `OKED_STRICT_FAIL_CLOSED` is read from the environment, not from this object.

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `OKED_API_KEY` env | OKed API key. Required. With no key, sensitive calls are denied. |
| `minTier` | `"safe" \| "warning" \| "review" \| "high_stakes"` | `"review"` | Lowest tier that can ask for approval. `warning` never blocks: only `review` and `high_stakes` do. Env `OKED_MIN_TIER` is the fallback when the config value is absent. |
| `alwaysApprove` | `string[]` | `[]` | Tool names that are always `high_stakes`, whatever the classifier says. |
| `alwaysAllow` | `string[]` | `[]` | Tool names that are always `safe`. Use sparingly. |
| `timeoutMs` | `number` | `630000` | Per-approval wait, in milliseconds (10.5 minutes, so the backend's 10 minute expiry answers first). Minimum `1000`, maximum `1800000`. |

## What gets gated

Names are matched against OpenClaw skill conventions, then unknown names default to `review`.

- **High stakes** (always an approval at the default `minTier`): names that send, post, publish, call, dial, charge, pay, delete, drop, deploy, or release, among the patterns in `src/classify-openclaw.ts`.
- **Review** (an approval at the default `minTier`): `create`, `update`, `write`, `edit`, `rename`, `modify`, and any tool name the classifier does not recognize.
- **Safe** (never gated): `get_*`, `list_*`, `search_*`, `read_*`, `find_*`, and the other read-style prefixes and suffixes in that file.
- **Bash / shell / exec**: deferred to the `@oked/sdk` shell classifier (`rm -rf`, `git push --force`, and the rest).

`warning` is logged by the SDK classifier and does not block, even if you set `minTier` below `review`.

## Degraded-mode behavior

Explicit denials, invalid API keys, a missing API key, receipts that do not verify, and unexpected plugin errors deny the tool call. If the backend is unreachable, OKed denies `high_stakes` and, by default, allows lower tiers. Set `OKED_STRICT_FAIL_CLOSED=1` to deny every sensitive action during an outage.

## Development

From the repo root:

```bash
npm install
npm run build
npm test
```

## License

[Apache-2.0](./LICENSE)
