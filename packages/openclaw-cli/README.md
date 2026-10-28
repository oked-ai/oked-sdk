# @oked/openclaw-cli

[![npm version](https://img.shields.io/npm/v/@oked/openclaw-cli.svg)](https://www.npmjs.com/package/@oked/openclaw-cli)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/openclaw-cli.svg)](./LICENSE)

Installer for the [`@oked/openclaw`](../openclaw) plugin. It runs `openclaw plugins install`, writes the OKed entry into `~/.openclaw/openclaw.json`, and can restart the gateway.

Approvals are decided in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon.

## Install

```bash
npm install -g @oked/openclaw @oked/openclaw-cli
oked-openclaw init
```

`openclaw` must already be on your PATH. `init` then:

1. Finds the plugin (a sibling `packages/openclaw` in this monorepo, or the global `@oked/openclaw` install).
2. Runs `openclaw plugins install --link <path>`.
3. Reuses `OKED_API_KEY` or an existing `plugins.entries.oked.apiKey`. Otherwise it pairs this device in the browser and saves the key to `~/.oked/config.json`. It does not ask you to paste a key.
4. Keeps `OKED_MIN_TIER` or an existing `minTier` when one is set. Otherwise a terminal asks (default `review`), and a non-interactive run uses `review`. Accepted values are `safe`, `warning`, `review`, and `high_stakes`.
5. Adds `"oked"` to `plugins.allow` and writes `plugins.entries.oked` with `enabled`, `apiKey`, `backendUrl`, and `minTier`. Existing keys on that entry are kept.
6. Looks for a running gateway (systemd user or system, pm2, launchd, or a bare process) and asks before restarting it.

## Subcommands

| Command | Description |
|---|---|
| `oked-openclaw init` | Install the plugin and update `openclaw.json` |
| `oked-openclaw status` | Show install state, config, and whether `GET /health` on the backend succeeds |
| `oked-openclaw test` | Send one `high_stakes` approval. Decide it in Telegram or on the dashboard. |
| `oked-openclaw uninstall` | Remove the OKed entry and run `openclaw plugins uninstall oked` |

## License

[Apache-2.0](./LICENSE)
