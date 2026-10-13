# @oked/claude-code

[![npm version](https://img.shields.io/npm/v/@oked/claude-code.svg)](https://www.npmjs.com/package/@oked/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Zero-code integration for Claude Code. Installs a `PreToolUse` hook that routes sensitive actions (destructive Bash commands, payment MCP tools, etc.) through the OKed backend and waits for a human decision before Claude Code proceeds.

Non-dangerous actions are left to Claude's normal permission flow - OKed only intervenes when it matters.

## Install

```bash
npm install -g @oked/claude-code
oked init
```

`oked init` writes a `PreToolUse` hook entry into the current project's `.claude/settings.json`, opens OKed's device-pairing flow in your browser, and stores the paired API key in `~/.oked/config.json`. Open a new Claude Code session in that project to activate the hook.

## Commands

| Command | What it does |
|---|---|
| `oked init` | Install or update the project hook and pair this device. It also updates an existing `oked-hook` entry in your user settings (`~/.claude/settings.json`), for example to a new timeout. Run it again after you update the package. |
| `oked status` | Show install state and ping the backend. |
| `oked receipts verify [file]` | Check this machine's copy of approval receipts (default `~/.oked/receipts.jsonl`): every signature, and the chain links between neighbouring receipts. |
| `oked uninstall` | Remove the project hook entry (other hooks are preserved). |

## What gets intercepted

The hook uses a four-tier classifier. Classification is **effect-based**: it
detects the *kind of effect* an action has rather than matching specific command
names, and **defaults to no prompt**. Only destructive, irreversible, or
outward-facing operations put a human in the loop.

| Tier | Behavior | Examples |
|---|---|---|
| `safe` | Auto-allow, no notification | Reads & queries, a DB `SELECT`, and any command with no detected side effect — `ls`, `grep`, `jq`, `node`, `npx`, plain `curl` GET (the default) |
| `warning` | Terminal log only, no push | A reversible local mutation: file create / `cp` / `mv`, a `/tmp` delete, local git (`add`/`commit`), `npm install`, SQL `INSERT`/`CREATE` |
| `review` | Push notification, tap to approve | Sensitive-path writes (`~/.ssh`, shell rc, system dirs, OKed config), `sudo`, outward message/email sends, MCP `create_*` / `send_*` / `update_*` |
| `high_stakes` | Push notification with confirmation | Destructive / irreversible / external: `rm` of non-temp data, `DROP TABLE` / `DELETE FROM`, `git push` / `reset --hard` / `branch -D`, `mkfs` / `dd`-to-device / `shutdown`, `curl` POST/DELETE, `ssh`/`scp`, `npm publish`, `kill` |

A Bash command that matches none of the prompt-worthy effect categories defaults
to `safe` — running a command is not, by itself, something we interrupt you for.
(Unknown non-Bash *tools* still default to `review`.)

## How it works

1. Claude Code fires the `PreToolUse` hook before every tool call.
2. The hook classifies the action locally (no network call for safe actions).
3. If it's high-stakes, it sends an approval request to the OKed backend.
4. You get a notification (Telegram, web push, or dashboard).
5. Approve or deny - Claude waits for your decision.

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | no, after pairing | Optional override. `oked init` normally stores the paired key in `~/.oked/config.json`. |
| `OKED_BACKEND_URL` | no | Override the hosted backend URL. |
| `OKED_STRICT_FAIL_CLOSED` | no | Set to `1` or `true` to deny every sensitive action when the backend is unreachable. |

## Receipts

Every decision comes with a receipt signed by OKed (who decided, how they were verified, the exact command, when). The hook verifies it before allowing the action, shows its short id (`Approved via OKed (receipt rcpt_7Q2FABCD)`), and keeps your own copy in `~/.oked/receipts.jsonl`. Check that file any time with `oked receipts verify`. Since 0.6.0 the hook denies any approval that comes without a valid receipt. Set `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts. See [docs/receipts.md](../../docs/receipts.md).

## Degraded-mode behavior

Explicit denials, invalid API keys and approval receipts that do not verify deny the action. If the backend is unreachable, OKed denies `high_stakes` actions and, by default, allows lower tiers so a temporary outage does not stop every Claude Code workflow. If no API key is configured, the hook returns `ask` so Claude Code's native permission flow can handle the decision. Set `OKED_STRICT_FAIL_CLOSED=1` to deny every sensitive action during backend outages.

The backend counts as unreachable when the connection fails, when it answers with HTTP 5xx, when the hosting platform answers in its place (for example Railway "Application not found"), or when the reply is not JSON. "Too many pending approvals" (HTTP 429) is not an outage: the hook denies the action and asks you to decide the waiting approvals first. Every deny reason shows the real error and its HTTP status.

## Decision log

The hook writes one JSON line to `~/.oked/hook.log` (mode 600) for each deny and ask, and for each degraded allow (`"degraded": true`: an action that ran without a person's decision because the backend was unreachable). Each line has the time, decision, tool, tier, reason, approval ID, receipt ID and error (name, message, HTTP status). The log never holds the tool input or the command. Above 1 MB, it moves to `hook.log.1`. Set `OKED_HOOK_LOG` to use another file.

## License

[MIT](./LICENSE)
