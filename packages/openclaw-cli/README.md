# @oked/openclaw-cli

Installer CLI for the [`@oked/openclaw`](../openclaw) plugin. Wraps `openclaw plugins install`, writes the OKed entry into `~/.openclaw/openclaw.json`, and restarts the gateway.

## Install

```bash
npm install -g @oked/openclaw @oked/openclaw-cli
oked-openclaw init
```

`init` will:

1. Locate the plugin source (sibling monorepo package or the global install).
2. Run `openclaw plugins install --link --force <path>`.
3. Prompt for `OKED_API_KEY` and `minTier` (defaults to `review`).
4. Write `plugins.allow: ["oked"]` and `plugins.entries.oked: { enabled, apiKey, minTier }` into `openclaw.json`.
5. Detect the OpenClaw daemon (systemd / pm2 / launchd / bare process) and offer to restart it.

## Subcommands

| Command | Description |
|---|---|
| `oked-openclaw init` | Install the plugin and configure openclaw.json |
| `oked-openclaw status` | Show install state, config, and backend reachability |
| `oked-openclaw test` | Send a test approval request via the OKed SDK |
| `oked-openclaw uninstall` | Remove the OKed entry and uninstall the plugin |

## License

[MIT](./LICENSE)
