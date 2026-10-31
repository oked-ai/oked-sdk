# @oked/scan

[![npm version](https://img.shields.io/npm/v/@oked/scan.svg)](https://www.npmjs.com/package/@oked/scan)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/scan.svg)](./LICENSE)

Local audit of command history already on this machine. It reads Claude Code transcripts and Codex CLI sessions and shows which commands OKed's default rules would have paused for approval.

Nothing leaves the machine. This command does not use the network and it does not send telemetry.

```bash
npx @oked/scan
npx @oked/scan --since 30
npx @oked/scan --json
```

The published binary name is `oked-scan` (`npx @oked/scan` runs it). Node.js 18 or newer.

Decisions for a later install happen in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## What it reads

| Source | Where | What counts |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | `Bash` tool calls. A missing directory is skipped. |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | Shell tool calls (`shell`, `shell_command`, `exec_command`, `local_shell`, and the same names the Codex hook maps). Other files in that folder, such as `history.jsonl`, are skipped. A missing directory is skipped. |

Claude Code lines follow the transcript shape: an `assistant` record whose `message.content` includes a `tool_use` block named `Bash`. A repeated tool id (a streamed line, or a copied record in a forked session) counts once. Codex lines follow the rollout shape: `response_item` / `function_call`, `local_shell_call`, and `exec_command_begin`. A repeated `call_id` counts once, including when a resumed session replays an earlier call.

A line that is not JSON is skipped. The report says how many.

## How a command is classified

Tiers come from `classify()` in [`@oked/sdk`](../sdk), the same function the hooks call. This package does not keep a second copy of the rules. Custom rules are not applied.

`review` and `high_stakes` would have paused for a person. `warning` and `safe` would have run.

Claude Code is classified with the Bash sandbox not containing child processes, which is the default unless you turn the sandbox on and set `allowUnsandboxedCommands` to false. Test runners and scripts (`npm test`, `cargo test`, `npx`, a script file) then count as `review`. Codex is classified the way [`@oked/codex`](../codex) classifies commands: that option is omitted, so the same runners stay allowed. One command can therefore differ by host. The report says so.

Categories are the classifier's operation kinds (`file_delete`, `git_force_push`, `npm_test`, and the rest), from `describeFields()`.

Commands in the report are truncated. Values that look like tokens, passwords, or URL userinfo are replaced with `[redacted]`. A home directory in a command is shown as `~`.

## Next step

There is no `@oked/cli` package. The last line of the report is the install command for the history that was found:

| History found | Command |
|---|---|
| Claude Code, or none | `npm install -g @oked/claude-code && oked init` |
| Codex only | `npm install -g @oked/codex && oked-codex init` |
| Both | `npm install -g @oked/claude-code @oked/codex && oked init && oked-codex init` |

Claude Code can also be installed with no global package. In Claude Code: `/plugin marketplace add oked-ai/oked-sdk`, then `/plugin install oked@oked`, then `/oked:pair`. See [plugins/claude-code](../../plugins/claude-code).

`@oked/scan` does not install a hook and does not pair a device.

## Options

| Option | |
|---|---|
| `--path <dir>` | Read this directory instead of your home directory. A home layout, `~/.claude/projects`, `~/.codex/sessions`, or a folder of transcript files. |
| `--since <days>` | Only commands timestamped in the last `<days>` days. Commands with no timestamp are still included. |
| `--json` | Print the report as JSON. |
| `--version` | Print the package version. |
| `-h`, `--help` | Show the usage text. |

Exit code 0 when the report is printed, including when no transcripts were found. Exit code 1 when the arguments are wrong or `--path` does not exist.

## Sample

The counts below are the fixture transcripts in this package (`test/fixtures`), not a person's machine. `npm test` pauses for Claude Code and does not pause for Codex, because those are the two defaults. `vercel --prod` is `high_stakes` with kind `unknown_bash`: the describer has no tighter label, and the tier is what pauses the command. The Claude Code curl is past the top 8. In the JSON report it is `curl -X POST https://example.com/hook -H "Authorization: Bearer [redacted]" -d hi`.

<!-- fixture-report -->
```
OKed scan 0.6.24
Local only. This scan does not use the network and does not send telemetry.

Claude Code   9 commands in 2 files
Codex CLI     7 commands in 2 files
Window        all history
Skipped 1 unreadable line.

Commands               16
Would have paused      10
  high_stakes           7
  review                3
Would have run          6
  warning               2
  safe                  4

Paused by category
  file_delete           3
  git_force_push        2
  http_post             2
  unknown_bash          2
  npm_test              1

Top risky commands
    1  claude-code  high_stakes  git_force_push     git push --force origin main
    1  claude-code  high_stakes  git_force_push     git push --force origin other
    1  claude-code  high_stakes  file_delete        rm -rf /etc/old
    1  claude-code  high_stakes  file_delete        rm -rf /var/data
    1  codex        high_stakes  file_delete        rm -rf /var/data
    1  claude-code  high_stakes  unknown_bash       vercel --prod
    1  codex        high_stakes  unknown_bash       vercel --prod
    1  codex        review       http_post          bash -lc 'curl -X POST https://example.com/hook -d hi'
  Showing 8 of 10. Re-run with --json for every paused command.

Tiers come from @oked/sdk classify(), the same function the hooks call. Custom rules are not applied.
A command would have paused when the tier is review or high_stakes. warning and safe would have run.
Claude Code is classified with the Bash sandbox not containing child processes, which is the default. Test runners and scripts then count as review.
Codex is classified the way the Codex hook classifies commands. Those runners stay allowed there.
Decisions happen in Telegram or on the web dashboard (https://oked.ai/dashboard). The iPhone app is coming soon.

Next: npm install -g @oked/claude-code @oked/codex && oked init && oked-codex init
```

## License

[Apache-2.0](./LICENSE)
