# @oked/claude-code

Zero-code human approval for Claude Code. Installs a `PreToolUse` hook that
routes sensitive actions (destructive Bash commands, payment MCP tools, etc.)
through the OKed backend and waits for a human decision before Claude Code
proceeds.

Non-dangerous actions are left to Claude's normal permission flow — OKed only
intervenes when it matters.

## Install

```bash
npm install -g @oked/claude-code
oked init
```

`oked init` prompts for an `OKED_API_KEY` and writes a PreToolUse hook entry
into `~/.claude/settings.json`. Open a new Claude Code session to activate.

## Commands

| Command | What it does |
|---|---|
| `oked init` | Install the hook and store the API key |
| `oked test` | Send a test approval request to verify your setup end-to-end |
| `oked status` | Show install state and ping the backend |
| `oked uninstall` | Remove the hook entry (other hooks are preserved) |

## What gets intercepted

Only genuinely sensitive operations:
- Bash commands classified `high_stakes` (`rm -rf`, `git push --force`,
  `DROP TABLE`, `docker system prune`, ...)
- MCP tools in the `warning` / `high_stakes` tiers (`send_email`,
  `create_payment`, `delete_*`, ...)

Everything else passes through silently — Claude's normal permission prompts
still work as usual.

## How it works

1. Claude Code fires the `PreToolUse` hook before every tool call
2. The hook classifies the action locally (no network call for safe actions)
3. If it's high-stakes, it sends an approval request to the OKed backend
4. You get a notification (Telegram, web push, or dashboard)
5. Approve or deny — Claude waits for your decision
6. If something goes wrong (backend down, timeout), the hook denies by default

## Environment

- `OKED_API_KEY` — stored in `settings.json.env` by `oked init`
- `OKED_BACKEND_URL` — optional override, defaults to the hosted backend

## License

MIT
