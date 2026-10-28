# @oked/claude-code

[![npm version](https://img.shields.io/npm/v/@oked/claude-code.svg)](https://www.npmjs.com/package/@oked/claude-code)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/claude-code.svg)](./LICENSE)

Claude Code hook. Sensitive actions wait for a person in Telegram or on the [web dashboard](https://oked.ai/dashboard) before Claude Code continues. The iPhone app is coming soon.

The gate itself is [`@oked/hook-core`](../hook-core) (`decide()`): classify, wait, check the signed receipt, fail closed. This package still reads Claude's stdin and writes Claude's `hookSpecificOutput`. Behavior is unchanged. An unpaired device returns `ask`. An allow is an explicit `permissionDecision`. `oked init` still writes the same hook entry, including the 690 second timeout.

Safe actions are allowed by the hook, with no notification. Warning actions are allowed and logged. OKed asks only for `review` and `high_stakes`.

## Install

```bash
npm install -g @oked/claude-code
oked init
```

`oked init` writes a `PreToolUse` hook into the current project's `.claude/settings.json`, opens the device-pairing page in your browser, and stores the API key in `~/.oked/config.json`. Open a new Claude Code session in that project.

On a TTY, unless `NO_COLOR` is set, init also prints a QR code of the pairing link. The QR opens that link in the phone's browser.

The approval window is 10 minutes. The hook process is allowed 690 seconds, and the SDK client waits 630 seconds, so a timeout becomes a deny instead of Claude killing the hook first.

## Commands

| Command | What it does |
|---|---|
| `oked init` | Install or update the project hook and pair this device. It also updates an existing `oked-hook` entry in user settings (`~/.claude/settings.json`), for example to raise an old timeout. Run it again after you update the package. |
| `oked init --key-only` | Create or show the API key in `~/.oked/config.json`. It does not add or change a hook. Use it for tools that only need the key, such as the [OpenShell](https://github.com/oked-ai/oked-openshell) middleware. The paired client type is `sdk`. |
| `oked init --no-browser` | Print the pairing link. Do not open a browser, and do not touch the clipboard. Works with `--key-only`. |
| `oked init --yes` (or `-y`) | Skip the "press Enter to open the browser" prompt. For a non-interactive shell. |
| `oked status` | Show install state and ping `GET /health` on the backend. |
| `oked receipts verify [file]` | Check this machine's receipts (default `~/.oked/receipts.jsonl`): every signature, and the chain links between neighbouring receipts. |
| `oked uninstall` | Remove the project hook entry. Other hooks are kept. |

## What gets intercepted

The hook uses a four-tier classifier. Classification is effect-based: it detects the kind of effect, not a list of command names, and it defaults to no prompt. Only destructive, irreversible, or outward-facing operations ask a person.

| Tier | Behavior | Examples |
|---|---|---|
| `safe` | Allow, no notification | Reads and queries, a DB `SELECT`, and any Bash command with no detected side effect: `ls`, `grep`, `jq`, `node`, `npx`, plain `curl` GET |
| `warning` | Terminal log only, no approval | A reversible local change (file create, `cp`, `mv`, a `/tmp` delete, local git `add`/`commit`, `npm install`, SQL `INSERT` or `CREATE`), plus a plain `git push` |
| `review` | Wait for approval | Sensitive-path writes (`~/.ssh`, shell rc, system dirs, OKed config), `sudo`, outward message or email sends, `curl` POST/PUT/PATCH with an inline body, other cloud CLI writes (`aws s3 cp` to a bucket, `kubectl apply`, `helm upgrade`, a preview deploy), MCP tools named `create_*`, `send_*`, or `update_*` |
| `high_stakes` | Wait for approval, with confirmation | Destructive or hard to undo: `rm` of non-temp data, `DROP TABLE` or `DELETE FROM`, a force push (`git push --force`, `-f`, or `--force-with-lease`), a remote branch delete (`git push --delete`, `-d`, or `git push origin :branch`), `reset --hard`, `branch -D`, `mkfs`, `dd` to a device, `shutdown`, `curl` DELETE, file upload, pay or send APIs, `ssh` / `scp`, `npm publish`, `kill`, cloud and cluster deletes (`aws s3 rm`, `kubectl delete`), `terraform apply` / `destroy`, production deploys (`vercel --prod`, `fly deploy`), Stripe CLI writes |

A Bash command that matches none of those effect categories defaults to `safe`. Cloud CLI reads (`aws s3 ls`, `kubectl get`, `terraform plan`), `--help`, and dry runs are `safe`. Running a command is not, by itself, a reason to interrupt you. Unknown tools that are not Bash default to `review`. MCP tools named `delete_*`, `drop_*`, or `remove_*` are `high_stakes`.

## How it works

1. Claude Code runs the `PreToolUse` hook (`oked-hook`) before the tool call. The hook is a separate process.
2. The hook classifies the action locally. `safe` and `warning` do not wait on the network, unless a cached user rule matches and the action has to be sent to the backend.
3. For `review` and `high_stakes`, it sends an approval request.
4. You decide in Telegram or on the web dashboard. Web push is optional.
5. Approve, and Claude continues. Deny or time out, and the tool call is denied.

If this device is not paired, the hook returns `ask`, so Claude Code's own permission prompt can decide.

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | no, after pairing | Optional override. `oked init` stores the paired key in `~/.oked/config.json`. |
| `OKED_BACKEND_URL` | no | Override the hosted backend URL. |
| `OKED_STRICT_FAIL_CLOSED` | no | `1` or `true` denies every sensitive action when the backend is unreachable. |
| `OKED_REQUIRE_RECEIPT` | no | `0` allows an approval with no receipt. On by default since 0.6.0. |
| `OKED_HOOK_LOG` | no | Decision log path. Default `~/.oked/hook.log`. |

## Receipts

Every decision comes with a receipt signed by OKed (who decided, how they were verified, the exact command, when). The hook verifies it before allowing the action, shows its short id (`Approved via OKed (receipt rcpt_7Q2FABCD)`), and keeps a copy in `~/.oked/receipts.jsonl`. Check that file with `oked receipts verify`. Since 0.6.0 the hook denies an approval that has no valid receipt. Set `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts.

You can also paste one receipt at [oked.ai/docs/#verify](https://oked.ai/docs#verify), or check an export with `npx @oked/verify`. See [docs/receipts.md](../../docs/receipts.md). Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Degraded-mode behavior

Explicit denials, invalid API keys, and receipts that do not verify deny the action. If the backend is unreachable, OKed denies `high_stakes` and, by default, allows lower tiers, so a short outage does not stop every workflow. Set `OKED_STRICT_FAIL_CLOSED=1` to deny every sensitive action during an outage.

The backend counts as unreachable when the connection fails, when it answers with HTTP 5xx, when the hosting platform answers in its place (for example Railway "Application not found"), or when the reply is not JSON. "Too many pending approvals" (HTTP 429) is not an outage: the hook denies the action and asks you to decide the waiting approvals first. Deny reasons include the error and its HTTP status.

If the hook cannot parse its stdin, it allows the call, so a bad payload does not crash Claude. Every other unexpected error denies.

## Decision log

The hook writes one JSON line to `~/.oked/hook.log` (mode 600) for each deny and ask, and for each degraded allow (`"degraded": true`: an action that ran without a person's decision because the backend was unreachable). Each line has the time, decision, tool, tier, reason, client, approval id, receipt id, and error (name, message, HTTP status). The log never holds the tool input or the command. Above 1 MB, the file moves to `hook.log.1`. Set `OKED_HOOK_LOG` to use another path.

## License

[Apache-2.0](./LICENSE)
