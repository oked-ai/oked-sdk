# @oked/openclaw

[![npm version](https://img.shields.io/npm/v/@oked/openclaw.svg)](https://www.npmjs.com/package/@oked/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Types: included](https://img.shields.io/npm/types/@oked/openclaw.svg)](./dist/index.d.ts)

Zero-code integration for OpenClaw. Registers a `before_tool_call` hook that fires for **every** tool the OpenClaw agent calls (built-in or skill-registered), classifies it, and freezes the agent on dangerous actions until you approve from the OKed mobile app.

## Why

OpenClaw's built-in iOS approvals cover **shell commands** (`exec.approval.*`). They do **not** automatically cover the skill / plugin tools agents actually use to touch the real world (sending iMessages, making phone calls, deploying sites, charging cards). Skill authors have to opt in to `plugin.approval.request`, and most don't. This plugin closes that gap.

## Install

```bash
npm install -g @oked/openclaw
oked-openclaw init
```

`oked-openclaw init` merges the plugin entry into `~/.openclaw/openclaw.json` (preserving anything else there), persists your `OKED_API_KEY`, detects how the OpenClaw daemon is running (systemd, pm2, launchd, or a bare process), and offers to restart it for you.

Other subcommands:

| Command | Description |
|---|---|
| `oked-openclaw status` | Show current install state + backend reachability |
| `oked-openclaw test` | Send a test approval request through the OKed SDK |
| `oked-openclaw uninstall` | Remove the OKed entry from `openclaw.json` |

If you'd rather configure it by hand, in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["oked"],
    "entries": {
      "oked": {
        "enabled": true,
        "apiKey": "ok_..."
      }
    }
  }
}
```

Then restart the gateway.

## Configuration

All keys go under `plugins.entries.oked`:

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `OKED_API_KEY` env | Your OKed API key. Required. |
| `backendUrl` | `string` | OKed hosted backend | Override the OKed backend URL. |
| `minTier` | `"review" \| "warning" \| "high_stakes"` | `"warning"` | Minimum risk tier that triggers approval. Set to `"high_stakes"` to only gate the most dangerous calls. |
| `alwaysApprove` | `string[]` | `[]` | Tool names to always require approval for, regardless of classifier. |
| `alwaysAllow` | `string[]` | `[]` | Tool names to never gate. Use sparingly. |
| `timeoutMs` | `number` | OKed default | Per-approval timeout in ms. |

## What gets gated

The classifier matches OpenClaw skill naming conventions:

- **High stakes** (always approval): `*_send`, `*_post`, `*_publish`, `*_call`, `*_dial`, `*_charge`, `*_pay`, `*_delete`, `*_drop`, `*_deploy`, `*_release`, ...
- **Warning** (approval at default `minTier`): `*_create`, `*_update`, `*_write`, `*_edit`, `*_rename`, `*_modify`.
- **Safe** (never gated): `get_*`, `list_*`, `search_*`, `read_*`, `find_*`.
- **Bash / shell / exec**: defers to the `@oked/sdk` shell classifier (`rm -rf`, `git push --force`, ...).

For tool names the classifier doesn't recognize, the default tier is `review` (not gated unless `minTier` is set to `"review"`).

## Fail-safe behavior

If the backend is unreachable, the request times out, or the API key is missing, the action is **denied**, not allowed. OKed never lets an agent proceed when in doubt.

## Comparison to OpenClaw built-in approvals

|  | OpenClaw `exec.approval.*` | `@oked/openclaw` |
|---|---|---|
| Shell commands | ✅ | ✅ (via classifier) |
| Skill / plugin tools | Only if skill author opts in | ✅ all tools |
| Mobile push | iOS app paired via `device-pairing` | OKed mobile app, unified across Claude Code + OpenClaw + future tools |
| Audit log | Gateway-local | Centralized OKed dashboard |

Use both. OpenClaw's exec approvals stay in place; this plugin layers on top to cover the skill surface.

## Development

```bash
npm install
npm run build
```

## License

[MIT](./LICENSE)
