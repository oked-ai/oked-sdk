# Watch mode

Watch mode lowers the cost of trying OKed. Risky actions run. OKed records each one it would have paused. Enforce mode, the default, pauses those actions until you approve in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon.

An existing install stays on enforce until you choose watch. A missing or unknown mode is enforce.

## Set it

| Where | What |
|---|---|
| `~/.oked/config.json` | `"mode": "watch"` or `"mode": "enforce"` |
| `OKED_MODE` | `watch` or `enforce`. This wins over the file. |
| `oked init --mode watch` | Saves the choice. On a terminal, `oked init` asks when nothing is set yet. A non-interactive run with no choice leaves enforce and does not change the file. |
| OpenClaw | `plugins.entries.oked.mode`, then `OKED_MODE`, then the config file. |
| SDK adapters | A `mode` option, then `OKED_MODE`, then the config file. |

`oked-codex init`, `oked-cursor init`, and `oked-copilot init` take the same `--mode` flag. They share `~/.oked/config.json`.

`approve()` on the client still waits for a person. Watch mode applies to the automatic gates (hooks, the OpenClaw plugin, and the SDK adapters), not to an explicit `approve()` call.

## What runs

In watch mode, a call that enforce mode would have paused is allowed:

- `review` and `high_stakes` at or above `minTier`
- a safe or warning call that a saved rule would have sent on for a decision
- an unpaired device, which enforce mode would ask (Claude Code, Claude Agent SDK) or deny (the other hosts)

Safe and warning calls that would have run anyway are not written to the watch log.

A classifier failure, a hook input that cannot be read, and an internal error still deny. Watch mode does not turn a broken gate into an allow.

## What is stored

The log is `~/.oked/watch.log` (mode 600). `OKED_WATCH_LOG` can point somewhere else. Above 1 MB the file moves to `watch.log.1`.

Each line is JSON:

| Field | Example |
|---|---|
| `ts` | time |
| `outcome` | `would_have_paused` |
| `tool` | `Bash` |
| `tier` | `high_stakes` |
| `client` | `@oked/claude-code@0.6.24` |
| `source` | `claude-code` |
| `reason` | `would have paused`, `would have paused (not paired)`, or `would have paused (saved rule)` |

Not stored: the command, tool arguments, description, working directory, session id, and API key. A command line can contain a secret, so the log keeps the tool name and the tier only.

`oked report` prints counts by tier and tool, and the latest lines. `oked-codex report`, `oked-cursor report`, `oked-copilot report`, and `oked-openclaw report` read the same file.

## What is sent

Watch mode does not send the action. The approval request is the call that holds an action until a person decides, so the gate does not make it.

| Call | In watch mode |
|---|---|
| Approval request | Not sent. No tool name, description, arguments, working directory, or session id. |
| Presence ping | May still be sent when an API key is set, at most once a day. The body is the machine hostname. It does not include the action. |
| Rules fetch | May still run for a safe or warning action, so a saved rule can be noted. The request does not include the action. |

There is no service endpoint that records a "would have paused" event and returns immediately, and none that notifies Telegram or the dashboard without holding the action. Until that exists, the record stays on this machine. `oked report` is how you read it.

To start pausing these actions, run `oked init --mode enforce`, or set `OKED_MODE=enforce`.
