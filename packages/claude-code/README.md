# @oked/claude-code

Zero-code human approval for Claude Code. Installs a `PreToolUse` hook that
routes sensitive actions (destructive Bash commands, payment MCP tools, etc.)
through the OKed backend and waits for a human decision before Claude Code
proceeds.

## Install

```bash
npm install -g @oked/claude-code
oked init
```

`oked init` prompts for an `OKED_API_KEY` and writes a PreToolUse hook entry
into `~/.claude/settings.json`. Open a new Claude Code session to activate.

## Commands

- `oked init` — install the hook and store the API key
- `oked status` — show install state and ping the backend
- `oked uninstall` — remove the hook entry (other hooks are preserved)

## What gets intercepted

Only genuinely sensitive operations:
- Bash commands classified `high_stakes` (`rm -rf`, `git push --force`,
  `DROP TABLE`, `docker system prune`, …)
- MCP tools in the `warning` / `high_stakes` tiers (`send_email`,
  `create_payment`, `delete_*`, …)

Everything else passes through without touching the backend.

## Environment

- `OKED_API_KEY` — stored in `settings.json.env` by `oked init`
- `OKED_BACKEND_URL` — optional override, defaults to the hosted backend

## License

MIT
