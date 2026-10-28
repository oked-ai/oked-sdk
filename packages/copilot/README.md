# @oked/copilot

[![npm version](https://img.shields.io/npm/v/@oked/copilot.svg)](https://www.npmjs.com/package/@oked/copilot)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/copilot.svg)](./LICENSE)

GitHub Copilot hook for the CLI and for VS Code. Sensitive actions wait for a person in Telegram or on the [web dashboard](https://oked.ai/dashboard) before Copilot continues. The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

Safe actions are allowed by the hook, with no notification. Warning actions are allowed and logged. OKed asks only for `review` and `high_stakes`.

VS Code hooks are Preview. The cloud coding agent can run the same project file, with the limits below.

## Install

```bash
npm install -g @oked/copilot
oked-copilot init
```

`oked-copilot init` writes `.github/hooks/oked.json` in the current project and stores the API key in `~/.oked/config.json`. The file it writes:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "command": "oked-copilot-hook",
        "timeoutSec": 690
      }
    ]
  }
}
```

There is no matcher, so every tool is included. Other hooks already in that file are kept. A second init does not add a second copy. It raises a `timeoutSec` below 690 and drops a conflicting `timeout` alias. The binary is `oked-copilot`, not `oked`, so it can sit next to `@oked/claude-code`. The cloud agent loads this same file.

Open a new Copilot CLI session, or a new Copilot chat in VS Code, in that project.

The approval window is 10 minutes. The hook is configured for 690 seconds, and the SDK client waits 630 seconds. Copilot's own default is 30 seconds. Read the timeout section: a timeout fails open even when the hook is a policy hook.

## Commands

| Command | What it does |
|---|---|
| `oked-copilot init` | Install or update the project hook and pair this device. If this project's Claude settings already have `oked-hook`, this does not add a second hook. |
| `oked-copilot init --native` | Install the Copilot hook even when a project Claude Code `oked-hook` is present. You will get two prompts until you remove that entry. |
| `oked-copilot init --no-browser` | Print the pairing link. Do not open a browser, and do not touch the clipboard. |
| `oked-copilot init --yes` (or `-y`) | Skip the "press Enter to open the browser" prompt. For a non-interactive shell. |
| `oked-copilot status` | Show install state and ping `GET /health` on the backend. |
| `oked-copilot uninstall` | Remove the Copilot hook entry. Other hooks in the file are kept. A Claude Code hook is not removed. |

## What gets intercepted

The hook uses the same four-tier classifier as `@oked/claude-code`. There is no matcher, so every tool is included. Unknown tools are `review` and wait for approval.

Copilot sends runtime names on `preToolUse` (`toolName`, `toolArgs`). A PascalCase `PreToolUse` payload uses Claude names (`tool_name`, `tool_input`). This hook accepts both.

| Copilot tool | OKed sees | Notes |
|---|---|---|
| `bash`, `powershell`, `Bash` | `Bash` | `ls` is safe. `rm` of a real file, a force push, network writes, and a production deploy wait. |
| `view`, `grep`, `glob`, `web_search` | `Read`, `Grep`, `Glob`, `WebSearch` | Safe. No prompt. |
| `web_fetch` | `WebFetch` | Warning. Allowed and logged. |
| `create` | `Write` | A project file is `warning`. A sensitive path is `review`. |
| `edit`, `str_replace_editor` | `Edit` | Same path rules as a write. |
| `apply_patch` | `Write` or `rm` | A delete in the patch is `rm`. |
| `ask_user`, `update_todo`, `task` | session tools | Safe, or `Agent` for `task`. The sub-agent's own tool calls are gated on their own. |
| `mcp__server__tool`, `MCP:server:tool` | the same MCP name | `list_*` and `get_*` are safe. `create_*` and `send_*` are `review`. `delete_*` is `high_stakes`. |
| anything else | the same name | Unknown tools wait for approval. |

The hooks reference does not list MCP tool names. A name this package does not recognize requires approval rather than passing through.

## How it works

1. Copilot runs `oked-copilot-hook` before the tool call. The hook is a separate process.
2. The hook classifies the action locally. `safe` and `warning` do not wait on the network, unless a cached user rule matches.
3. For `review` and `high_stakes`, it sends an approval request.
4. You decide in Telegram or on the web dashboard. Web push is optional.
5. Approve, and the hook prints `{"permissionDecision":"allow"}`. Deny or time out, and it prints `permissionDecision: "deny"` with `permissionDecisionReason`.

Empty output uses Copilot's normal permission flow, which can still prompt. A safe call therefore prints an explicit allow, so it runs with no prompt.

`ask` is turned into deny in the cloud agent and in CLI autopilot. This hook never prints `ask`. If this device is not paired, the hook denies. The reason is `Pair first: run oked-copilot init`.

The hook exits 0. A non-zero exit on `preToolUse` denies the tool, even if stdout says allow. A timeout does the opposite: the tool continues. See below.

## Timeout

`timeoutSec` is seconds. The default is 30. `timeout` is an alias used only when `timeoutSec` is absent. The docs do not state a maximum. Checked on 2026-10-28 at [the hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).

`oked-copilot init` sets `timeoutSec` to 690 and removes a `timeout` alias so the two cannot disagree. It raises a lower value. A higher `timeoutSec` you set yourself is left alone.

Command `preToolUse` hooks fail closed on a crash or any non-zero exit. Timeouts always fail open, including for admin policy hooks. Copilot logs a warning and lets the tool continue through the normal permission flow. There is no `failClosed` field to change that.

If Copilot honors 690, the SDK's deny (at 630 seconds) is written before the process is killed. If a build caps the wait below that, the kill fails open. Confirm `timeoutSec: 690` once in Copilot CLI and once in VS Code before you rely on a 10 minute approval.

## Claude Code hooks, and asking twice

Copilot CLI and VS Code read repository `.claude/settings.json` and `.claude/settings.local.json`, in addition to `.github/hooks/*.json`. Docs: [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) and [VS Code hooks](https://code.visualstudio.com/docs/copilot/customization/hooks). They do not read `~/.claude/settings.json`. A user-level Claude hook does not gate Copilot, so init still installs the native hook in that case.

A project `oked-hook` plus `.github/hooks/oked.json` would ask twice. `oked-copilot init` looks for that project entry. If it finds one, and the native hook is not already installed, it does not write `oked.json`. Pairing still runs. Both hooks read `~/.oked/config.json`.

The imported hook is the Claude Code one. It returns `ask` when the device is not paired. Copilot cloud agent and CLI autopilot turn `ask` into deny. An interactive CLI may still prompt. The native hook denies with a pairing message instead.

`oked-copilot init --native` installs even when the project Claude hook is present, and it says that you will be asked twice. Init never deletes the Claude hook. `oked uninstall` from `@oked/claude-code` removes it, and that also removes it from Claude Code.

## Cloud coding agent

The cloud agent loads only `.github/hooks/*.json` from the repository. It does not load user hooks, `settings.json`, or Claude settings. Putting this file in the repo is what reaches a cloud job.

The job's network is limited to GitHub hosts unless an org admin allows the OKed API (`api.oked.ai`). Without that allow rule the hook cannot reach the backend. `high_stakes` is then denied. Lower tiers follow the usual outage rule unless `OKED_STRICT_FAIL_CLOSED` is set.

`permissionRequest` does not decide tools in the cloud. `preToolUse` does, and `ask` is deny. The whole wait counts against the job timeout. A 10 minute approval can outlive the job. For a cloud job, prefer a person who can answer quickly, or keep the hook for the CLI and VS Code only.

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | no, after pairing | Optional override. `oked-copilot init` stores the paired key in `~/.oked/config.json`. |
| `OKED_STRICT_FAIL_CLOSED` | no | `1` or `true` denies every sensitive action when the backend is unreachable. |
| `OKED_REQUIRE_RECEIPT` | no | `0` allows an approval with no receipt. On by default since 0.6.0. |
| `OKED_HOOK_LOG` | no | Decision log path. Default `~/.oked/hook.log`. |

## Receipts

Every decision comes with a receipt signed by OKed. The hook verifies it before allowing the action and keeps a copy in `~/.oked/receipts.jsonl`. Since 0.6.0 the hook denies an approval that has no valid receipt. Set `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts.

You can paste one receipt at [oked.ai/docs/#verify](https://oked.ai/docs#verify), or check an export with `npx @oked/verify`. See [docs/receipts.md](../../docs/receipts.md).

## Degraded-mode behavior

Explicit denials, invalid API keys, and receipts that do not verify deny the action. If the backend is unreachable, OKed denies `high_stakes` and, by default, allows lower tiers. Set `OKED_STRICT_FAIL_CLOSED=1` to deny every sensitive action during an outage.

HTTP 429 (too many approvals already waiting) is not an outage: the action is denied until those are decided in Telegram or on the dashboard.

If the hook cannot parse its stdin, it denies. A bad payload must not become a silent allow.

## Decision log

The hook writes one JSON line to `~/.oked/hook.log` (mode 600) for each deny, and for each degraded allow. The log never holds the tool input or the command.

## Uninstall

`oked-copilot uninstall` removes only the `oked-copilot-hook` entry from `.github/hooks/oked.json`. Other hooks in that file stay. If that was the only hook, the file is deleted. A Claude Code `oked-hook` entry is left in place. The API key in `~/.oked/config.json` stays.

## Troubleshooting

- Hook never runs: open a new Copilot CLI session or a new VS Code chat. `oked-copilot-hook` must be on `PATH`. VS Code hooks are Preview.
- The tool ran anyway after a long wait: Copilot kills the hook at `timeoutSec` and fails open, including for policy hooks. There is no `failClosed` switch. Confirm the file says 690. A live check is still required, because the docs state no maximum.
- Two cards for one action: this project's `.claude/settings.json` or `.claude/settings.local.json` also has `oked-hook`. Copilot CLI and VS Code read those files. `oked-copilot init` skips the native file when it finds one. `--native` installs anyway and warns. A user-level `~/.claude/settings.json` hook does not run in Copilot, so it does not block init.
- `Pair first: run oked-copilot init`: no API key. The hook denies. It does not print `ask`.
- Backend down: `high_stakes` is denied. Lower tiers are allowed unless `OKED_STRICT_FAIL_CLOSED=1`. Nobody answering within 10 minutes is a deny.
- Cloud agent: only `.github/hooks/oked.json` from the repo is loaded. An org admin must allow `api.oked.ai`. The wait counts against the job timeout. `ask` is deny there.
- Still stuck: [contact@oked.ai](mailto:contact@oked.ai).

## License

[Apache-2.0](./LICENSE)
