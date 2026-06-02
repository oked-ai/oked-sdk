# @oked/openclaw

[![npm version](https://img.shields.io/npm/v/@oked/openclaw.svg)](https://www.npmjs.com/package/@oked/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Types: included](https://img.shields.io/npm/types/@oked/openclaw.svg)](./dist/index.d.ts)

Zero-code integration for OpenClaw. Registers a `before_tool_call` hook that fires for **every** tool the OpenClaw agent calls (built-in or skill-registered), classifies it, and freezes the agent on dangerous actions until you approve from the OKed mobile app.

## Why

OpenClaw's built-in iOS approvals cover **shell commands** (`exec.approval.*`). They do **not** automatically cover the skill / plugin tools agents actually use to touch the real world (sending iMessages, making phone calls, deploying sites, charging cards). Skill authors have to opt in to `plugin.approval.request`, and most don't. This plugin closes that gap.

## Install

```bash
npm install -g @oked/openclaw @oked/openclaw-cli
oked-openclaw init
```

The CLI ([`@oked/openclaw-cli`](../openclaw-cli)) runs `openclaw plugins install --link` against this package, prompts for your API key + `minTier`, writes the entry into `~/.openclaw/openclaw.json`, and restarts the OpenClaw daemon.

If you'd rather do it by hand:

```bash
openclaw plugins install --link <path-to-this-package>
```

Then in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["oked"],
    "entries": {
      "oked": {
        "enabled": true,
        "apiKey": "ok_...",
        "backendUrl": "https://api.oked.ai",
        "minTier": "review"
      }
    }
  }
}
```

Restart the OpenClaw gateway and you're done.

## Configuration

All keys go under `plugins.entries.oked`:

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `OKED_API_KEY` env | Your OKed API key. Required. |
| `backendUrl` | `string` | `https://api.oked.ai` | Override the OKed backend URL. |
| `minTier` | `"review" \| "high_stakes"` | `"review"` | Minimum risk tier that triggers approval. Set to `"high_stakes"` to only gate the most dangerous calls. `warning` is informational only and does not block. |
| `alwaysApprove` | `string[]` | `[]` | Tool names to always require approval for, regardless of classifier. |
| `alwaysAllow` | `string[]` | `[]` | Tool names to never gate. Use sparingly. |
| `timeoutMs` | `number` | `300000` | Per-approval timeout in ms. |

## What gets gated

The classifier matches OpenClaw skill naming conventions:

- **High stakes** (always approval): `*_send`, `*_post`, `*_publish`, `*_call`, `*_dial`, `*_charge`, `*_pay`, `*_delete`, `*_drop`, `*_deploy`, `*_release`, ...
- **Review** (approval at default `minTier`): `*_create`, `*_update`, `*_write`, `*_edit`, `*_rename`, `*_modify`, and unknown tool names.
- **Warning** (log / allow): lower-risk state changes from shared SDK classifiers.
- **Safe** (never gated): `get_*`, `list_*`, `search_*`, `read_*`, `find_*`.
- **Bash / shell / exec**: defers to the `@oked/sdk` shell classifier (`rm -rf`, `git push --force`, ...).

For tool names the classifier doesn't recognize, the default tier is `review`, so they are gated by the default configuration.

## Degraded-mode behavior

Explicit denials, invalid API keys, missing API keys, and unexpected plugin errors deny sensitive tool calls. If the backend is unreachable, OKed denies `high_stakes` actions and, by default, allows lower tiers so a temporary outage does not stop every OpenClaw workflow. Set `OKED_STRICT_FAIL_CLOSED=1` to deny every sensitive action during backend outages.

## Comparison to OpenClaw built-in approvals

|  | OpenClaw `exec.approval.*` | `@oked/openclaw` |
|---|---|---|
| Shell commands | OK | OK (via classifier) |
| Skill / plugin tools | Only if skill author opts in | OK all tools |
| Mobile push | iOS app paired via `device-pairing` | OKed mobile app, unified across Claude Code + OpenClaw + future tools |
| Audit log | Gateway-local | Centralized OKed dashboard |

Use both. OpenClaw's exec approvals stay in place; this plugin layers on top to cover the skill surface.

## Development

```bash
npm install
npm run build
npm test
```

## License

[MIT](./LICENSE)
