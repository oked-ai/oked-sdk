# @oked/cursor

[![npm version](https://img.shields.io/npm/v/@oked/cursor.svg)](https://www.npmjs.com/package/@oked/cursor)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/cursor.svg)](./LICENSE)

Cursor agent hook. Sensitive actions wait for a person in Telegram or on the [web dashboard](https://oked.ai/dashboard) before Cursor continues. The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

Safe actions are allowed by the hook, with no notification. Warning actions are allowed and logged. OKed asks only for `review` and `high_stakes`.

## Install

```bash
npm install -g @oked/cursor
oked-cursor init
```

`oked-cursor init` writes `.cursor/hooks.json` in the current project and stores the API key in `~/.oked/config.json`. The file it writes:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "oked-cursor-hook",
        "timeout": 690,
        "failClosed": true
      }
    ]
  }
}
```

There is no matcher, so every tool is included. Other hooks already in that file are kept. A second init does not add a second copy. It raises a timeout below 690 and sets `failClosed` to true. The binary is `oked-cursor`, not `oked`, so it can sit next to `@oked/claude-code`.

Open a new Cursor agent session in that project. Cursor reloads `hooks.json` when it changes.

The approval window is 10 minutes. The hook is configured for 690 seconds, and the SDK client waits 630 seconds, so a timeout can become a deny instead of Cursor killing the hook first. Read the timeout section before you rely on that. Cursor does not document a maximum.

## Commands

| Command | What it does |
|---|---|
| `oked-cursor init` | Install or update the project hook and pair this device. If a Claude Code `oked-hook` is already installed, this does not add a second hook. |
| `oked-cursor init --native` | Install the Cursor hook even when a Claude Code `oked-hook` is present. You will get two prompts unless you turn third-party imports off. |
| `oked-cursor init --no-browser` | Print the pairing link. Do not open a browser, and do not touch the clipboard. |
| `oked-cursor init --yes` (or `-y`) | Skip the "press Enter to open the browser" prompt. For a non-interactive shell. |
| `oked-cursor init --mode watch` | Let risky actions run and record what would have paused. `--mode enforce` is the default. |
| `oked-cursor report` | Summarize `~/.oked/watch.log`. See [docs/watch.md](../../docs/watch.md). |
| `oked-cursor status` | Show install state, the mode, and ping `GET /health` on the backend. |
| `oked-cursor uninstall` | Remove the Cursor hook entry. Other hooks in `.cursor/hooks.json` are kept. A Claude Code hook is not removed. |

## What gets intercepted

The hook uses the same four-tier classifier as `@oked/claude-code`. The matcher is omitted, so every tool is included. Unknown tools are `review` and wait for approval.

| Cursor tool | OKed sees | Notes |
|---|---|---|
| `Shell` | `Bash` | `ls` is safe. `rm` of a real file, a force push, network writes, and a production deploy wait. |
| `Read`, `Grep`, `Glob`, `WebSearch` | the same name | Safe. No prompt. |
| `WebFetch` | `WebFetch` | Warning. Allowed and logged. |
| `Write`, `Edit`, `StrReplace` | `Write` or `Edit` | A project file is `warning`. A sensitive path (`/etc`, `~/.ssh`, shell rc, OKed config) is `review`. |
| `Delete` | `rm` | A temp file is `warning`. Anything else is `high_stakes`. No path is `review`. |
| `MCP:<tool>` or `MCP:<server>:<tool>` | `mcp__...` | `list_*` and `get_*` are safe. `create_*` and `send_*` are `review`. `delete_*` is `high_stakes`. |
| `Task` | `Agent` | Starting a sub-agent is safe. Its own tool calls are gated on their own. |
| anything else | the same name | Unknown tools wait for approval. |

Cloud agents load project hooks only (`.cursor/hooks.json`). `preToolUse` fires for MCP tools there, named `MCP:<tool_name>`. For HTTP MCP servers, `preToolUse` can deny the call. Cursor ignores `updated_input` on those. `beforeMCPExecution` does not fire in the cloud.

## How it works

1. Cursor runs `oked-cursor-hook` before the tool call. The hook is a separate process.
2. The hook classifies the action locally. `safe` and `warning` do not wait on the network, unless a cached user rule matches.
3. For `review` and `high_stakes`, it sends an approval request.
4. You decide in Telegram or on the web dashboard. Web push is optional.
5. Approve, and the hook prints `{"permission":"allow"}`. Deny or time out, and it prints `permission: "deny"` with `user_message` and `agent_message`.

`preToolUse` accepts `"ask"` and does not enforce it ([Cursor hooks](https://cursor.com/docs/hooks)). This hook never prints `ask`. If this device is not paired, the hook denies. The reason is `Pair first: run oked-cursor init`.

The hook exits 0 and prints JSON. Cursor treats exit code 2 as deny as well. Other non-zero exits fail open unless `failClosed` is set. This hook sets `failClosed: true`, so a crash, a timeout, or no output denies the action.

## Timeout

Cursor's hook reference says `timeout` is seconds and the default is "platform default". It does not say how many seconds that is, and it does not say there is a maximum. Checked on 2026-10-28 at [cursor.com/docs/hooks](https://cursor.com/docs/hooks).

`oked-cursor init` writes `"timeout": 690` and `"failClosed": true`. 690 is 60 seconds above the SDK wait of 630. If Cursor honors 690, the SDK's deny is written before the process is killed. If Cursor ignores a timeout that long, or kills the hook earlier, `failClosed` denies the action instead of letting it through.

This has not been confirmed inside the Cursor app. Before you depend on a 10 minute approval, run one real session with `timeout: 690` and check that Cursor waits and that an approval comes back as `allow`.

A Windows CLI report says some builds wait out the whole timeout and then drop the hook's answer: [forum thread](https://forum.cursor.com/t/cli-hooks-block-each-tool-call-for-the-full-timeout-lowering-it-silently-disables-deny-hooks-windows/169942). On that bug, `failClosed: true` denies an approval as well as a denial, because the verdict is discarded at the deadline. Treat a live check on your machine as required.

## Claude Code hooks, and asking twice

Cursor loads Claude Code hooks when "Include Third-Party Plugins, Skills, and Other Configs" is on. That setting is on by default. The files are `.claude/settings.local.json`, `.claude/settings.json`, and `~/.claude/settings.json`. Every matching hook runs. A higher-priority answer wins when they disagree. See [third-party hooks](https://cursor.com/docs/reference/third-party-hooks).

An `oked-hook` entry in one of those files plus this package would send two approval requests for one action.

`oked-cursor init` looks for that entry. If it finds one, and this project does not already have the native hook, it does not write `.cursor/hooks.json`. Cursor will run the Claude Code hook that is already there. Pairing still runs, because both hooks read `~/.oked/config.json`.

That imported hook is the Claude Code one. Two gaps matter:

- It returns `ask` when the device is not paired. Cursor does not enforce `ask` on `preToolUse`.
- Claude settings have no `failClosed` field. Cursor's default is false, so a timeout or a crash of the imported hook fails open. The docs do not say that imported hooks turn `failClosed` on.

If you want the native hook (deny when unpaired, `failClosed: true`, Cursor names such as `Shell` and `MCP:`), turn the third-party import setting off, or remove the `oked-hook` entry, and run `oked-cursor init --native`. `--native` installs even when the Claude hook is present. Leave the import setting on only if you accept two prompts.

Init never deletes the Claude hook. `oked uninstall` from `@oked/claude-code` removes it, and that also removes it from Claude Code.

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | no, after pairing | Optional override. `oked-cursor init` stores the paired key in `~/.oked/config.json`. |
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

`oked-cursor uninstall` removes only the `oked-cursor-hook` entry from `.cursor/hooks.json`. Other hooks stay. If that was the only hook, the file is deleted. A Claude Code `oked-hook` entry is left in place. The API key in `~/.oked/config.json` stays.

## Troubleshooting

- Hook never runs: open a new agent session. The command `oked-cursor-hook` must be on `PATH` (a global install does that). Project hooks run only in a trusted workspace.
- The tool ran anyway: Cursor's timeout is undocumented. If it kills the process early, `failClosed: true` should deny. A live check is still required. See the timeout section. On the reported Windows CLI bug, the verdict is dropped at the deadline and `failClosed` denies an approval too.
- Two cards for one action: a Claude Code `oked-hook` is also loaded. Turn off third-party imports, or remove that entry. `oked-cursor init` skips the native file when it finds one. `oked-cursor init --native` installs anyway and warns.
- `Pair first: run oked-cursor init`: no API key. The hook denies. It does not print `ask`.
- Backend down: `high_stakes` is denied. Lower tiers are allowed unless `OKED_STRICT_FAIL_CLOSED=1`. Nobody answering within 10 minutes is a deny.
- Cloud agents load `.cursor/hooks.json` only. HTTP MCP calls can be denied. Cursor ignores `updated_input` for those.
- Still stuck: [contact@oked.ai](mailto:contact@oked.ai).

## License

[Apache-2.0](./LICENSE)
