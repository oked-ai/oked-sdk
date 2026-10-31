# @oked/openclaw-cli

[![npm version](https://img.shields.io/npm/v/@oked/openclaw-cli.svg)](https://www.npmjs.com/package/@oked/openclaw-cli)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/openclaw-cli.svg)](./LICENSE)

Pairing CLI for the [`@oked/openclaw`](../openclaw) plugin. Install the plugin with `openclaw plugins install npm:@oked/openclaw`, then use this CLI to pair the device, write the OKed entry into `~/.openclaw/openclaw.json`, and restart the gateway. The plugin requires OpenClaw 2026.5.4 or newer.

Approvals are decided in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon.

## Install

```bash
openclaw plugins install npm:@oked/openclaw
npm install -g @oked/openclaw-cli
oked-openclaw init
```

Once the package is listed on ClawHub, `openclaw plugins install @oked/openclaw` installs it from there.

`openclaw` must already be on your PATH. `init` then:

1. If a local checkout or a global npm copy of `@oked/openclaw` is present, runs `openclaw plugins install --link <path>`. If the plugin is already installed and no local copy is present, skips install. Otherwise it tries `openclaw plugins install @oked/openclaw` (ClawHub). If that fails, it retries `openclaw plugins install npm:@oked/openclaw`.
2. Reuses `OKED_API_KEY` or an existing `plugins.entries.oked.apiKey`. Otherwise it pairs this device in the browser and saves the key to `~/.oked/config.json`. It does not ask you to paste a key.
3. Keeps `OKED_MIN_TIER` or an existing `minTier` when one is set. Otherwise a terminal asks (default `review`), and a non-interactive run uses `review`. Accepted values are `safe`, `warning`, `review`, and `high_stakes`.
4. Adds `"oked"` to `plugins.allow` and writes `plugins.entries.oked` with `enabled`, `apiKey`, and `minTier`. Existing keys on that entry are kept.
5. Looks for a running gateway (systemd user or system, pm2, launchd, or a bare process) and asks before restarting it.

## Subcommands

| Command | Description |
|---|---|
| `oked-openclaw init` | Install the plugin if needed, pair this device, and update `openclaw.json` |
| `oked-openclaw status` | Show install state, config, and whether `GET /health` on the backend succeeds |
| `oked-openclaw test` | Send one `high_stakes` approval. Decide it in Telegram or on the dashboard. |
| `oked-openclaw uninstall` | Remove the OKed entry and run `openclaw plugins uninstall oked` |

## License

[Apache-2.0](./LICENSE)
