# @oked/claude-code

[![npm version](https://img.shields.io/npm/v/@oked/claude-code.svg)](https://www.npmjs.com/package/@oked/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Zero-code integration for Claude Code. Installs a `PreToolUse` hook that routes sensitive actions (destructive Bash commands, payment MCP tools, etc.) through the OKed backend and waits for a human decision before Claude Code proceeds.

Non-dangerous actions are left to Claude's normal permission flow — OKed only intervenes when it matters.

## Install

```bash
npm install -g @oked/claude-code
oked init
```

`oked init` prompts for an `OKED_API_KEY` and writes a `PreToolUse` hook entry into `~/.claude/settings.json`. Open a new Claude Code session to activate.

## Commands

| Command | What it does |
|---|---|
| `oked init` | Install the hook and store the API key. |
| `oked test` | Send a test approval request to verify your setup end-to-end. |
| `oked status` | Show install state and ping the backend. |
| `oked uninstall` | Remove the hook entry (other hooks are preserved). |

## What gets intercepted

The hook uses a four-tier classifier:

| Tier | Behavior | Examples |
|---|---|---|
| `safe` | Auto-allow, no notification | `Read`, `Glob`, read-only Bash (`ls`, `git status`, plain `curl` GET) |
| `warning` | Terminal log only, no push | `Write` / `Edit` / `NotebookEdit` on a file inside the project |
| `review` | Push notification, tap to approve | `Write` / `Edit` on a file outside the project, MCP `create_*` / `send_*` / `update_*` |
| `high_stakes` | Push notification with confirmation | `rm -rf`, `git push --force`, `DROP TABLE`, `delete_*` MCP tools |

Everything not matched by the classifier defaults to `review`.

## How it works

1. Claude Code fires the `PreToolUse` hook before every tool call.
2. The hook classifies the action locally (no network call for safe actions).
3. If it's high-stakes, it sends an approval request to the OKed backend.
4. You get a notification (Telegram, web push, or dashboard).
5. Approve or deny — Claude waits for your decision.

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | yes | Stored under `env.OKED_API_KEY` in `~/.claude/settings.json` by `oked init`. |
| `OKED_BACKEND_URL` | no | Override the hosted backend URL. |

## Fail-safe behavior

If the backend is unreachable, the request times out, or the API key is missing, the action is **denied**, not allowed. OKed never lets an agent proceed when in doubt.

## License

[MIT](./LICENSE)
