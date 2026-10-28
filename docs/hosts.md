# Supported hosts

OKed stops a risky tool call until a person decides in Telegram or on the [web dashboard](https://oked.ai/dashboard?ref=github-oked-sdk). The iPhone app is coming soon. Contact is [contact@oked.ai](mailto:contact@oked.ai).

| Host | Package | Install |
|---|---|---|
| Claude Code | [`@oked/claude-code`](../packages/claude-code) | `npm install -g @oked/claude-code`, then `oked init`. Writes `.claude/settings.json`. Unpaired devices return `ask`. The gate is `@oked/hook-core`, and Claude's behavior is unchanged. |
| Codex CLI | [`@oked/codex`](../packages/codex) | `npm install -g @oked/codex`, then `npx oked-codex init`. Writes `.codex/hooks.json` with timeout 690. Run `/hooks` and trust the hook. Timeouts fail open. An allow prints nothing. |
| Cursor | [`@oked/cursor`](../packages/cursor) | `npm install -g @oked/cursor`, then `oked-cursor init`. Writes `.cursor/hooks.json` with timeout 690 and `failClosed: true`. The real timeout ceiling is not documented. Skips install when a Claude Code hook would also run. `--native` installs anyway. |
| Claude Agent SDK | [`@oked/claude-agent-sdk`](../packages/claude-agent-sdk) | `npm install @oked/claude-agent-sdk`, then pass `okedHooks()`. |
| OpenClaw | [`@oked/openclaw`](../packages/openclaw) | `npm install -g @oked/openclaw @oked/openclaw-cli`, then `oked-openclaw init`. |
| NVIDIA OpenShell | [oked-openshell](https://github.com/oked-ai/oked-openshell) | Separate repo. `oked init --key-only` creates a key and does not install the Claude Code hook. |
| Any Node.js agent | [`@oked/sdk`](../packages/sdk) | `npm install @oked/sdk`, then call `approve()`. |

[`@oked/hook-core`](../packages/hook-core) is the shared gate those hooks call. It has no `init` command. Do not install it on its own unless you are building a host package.

The hook timeout hosts should set, when they allow it, is 690 seconds (`HOOK_TIMEOUT_SECONDS`). That sits above the SDK wait of 630 seconds.
