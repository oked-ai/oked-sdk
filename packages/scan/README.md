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

Claude Code is classified with the Bash sandbox not containing child processes, which is the default unless you turn the sandbox on and set `allowUnsandboxedCommands` to false. Test runners and scripts (`npm test`, `cargo test`, `npx`, a script file) then count as `review`. That is what the Claude Code hook does by default: with no sandbox settings, it asks before `npm test`. Codex is classified the way [`@oked/codex`](../codex) classifies commands: that option is omitted, so the same runners stay allowed. One command can therefore differ by host. `oked-scan --verbose` prints these notes. The default text report leaves the notes out, and it puts those runners on their own line instead of hiding them.

The text report uses plain words. Tiers are "High-stakes (always asks)", "Worth a look (asks)", "Runs, logged", and "Runs". Kinds are "rm -rf / file delete", "force-push", "curl POST/PUT/DELETE", "destructive SQL", "prod deploy", "npm publish", and so on. `--json` keeps the machine names (`high_stakes`, `file_delete`, and the rest) and adds `tierLabel` and `categoryLabel`.

Commands in the report are truncated. Values that look like tokens, passwords, or URL userinfo are replaced with `[redacted]`. A home directory in a command is shown as `~`.

## Next step

There is no `@oked/cli` package. The report ends with how many commands would have paused, leaving test runners and scripts out of that count, the two or three most common high-stakes kinds in plain words (force-push, rm -rf / file delete, destructive SQL, prod deploy, and so on), then the install command for the history that was found, then `https://oked.ai`. Those runners stay in the totals, on their own line, with how to allow them. If history exists and nothing would have paused, the report says so and does not invent a count. If no Claude Code transcripts and no Codex sessions are found, it says that no history was found at the paths checked, suggests `--path <dir>`, and does not print a zero table. A short line says decisions happen in Telegram or on the web dashboard. The iPhone app is coming soon.

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
| `--verbose` | Print how commands are classified. The default text report leaves those notes out. |
| `--json` | Print the report as JSON. This ignores `--verbose`. |
| `--version` | Print the package version. |
| `-h`, `--help` | Show the usage text. |

Exit code 0 when the report is printed, including when no transcripts were found. Exit code 1 when the arguments are wrong or `--path` does not exist.

## Sample

The counts below are the fixture transcripts in this package (`test/fixtures`), not a person's machine. `npm test` asks for Claude Code and does not ask for Codex, because those are the two hook defaults. The Claude Code one is the routine line. It stays in "Would have paused" and out of the closing count. `vercel --prod` is high-stakes, kind `deploy`. The Claude Code curl is past the top 8. In the JSON report it is `curl -X POST https://example.com/hook -H "Authorization: Bearer [redacted]" -d hi`. When no history is found, the report says so and does not print a zero table.

<!-- fixture-report -->
```
OKed scan 0.6.25
Local only. This scan does not use the network and does not send telemetry.

Claude Code   9 commands in 2 files
Codex CLI     7 commands in 2 files
Window        all history
Skipped 1 unreadable line.

Commands                          16
Would have paused                 10
  High-stakes (always asks)        7
    Destructive or hard to undo.
  Worth a look (asks)              3
    OKed asks before it runs.
Would have run                     6
  Runs, logged                     2
    It runs, and OKed logs it.
  Runs                             4
    It runs. No log line.

What would pause
  7 high-stakes: 3 rm -rf / file delete, 2 force-pushes, 2 prod deploys
  3 worth a look: 2 curl POST/PUT/DELETE, 1 test runner

Top risky commands
  High-stakes (always asks)
      1  claude-code  force-push             git push --force origin main
      1  claude-code  force-push             git push --force origin other
      1  claude-code  rm -rf / file delete   rm -rf /etc/old
      1  claude-code  rm -rf / file delete   rm -rf /var/data
      1  codex        rm -rf / file delete   rm -rf /var/data
      1  claude-code  prod deploy            vercel --prod
      1  codex        prod deploy            vercel --prod
  Worth a look (asks)
      1  codex        curl POST/PUT/DELETE   bash -lc 'curl -X POST https://example.com/hook -d hi'
  Showing 8 of 10. Re-run with --json for every paused command.

1 routine command (test runners, scripts) would also ask under Claude Code's default sandbox setting.
To allow those without a prompt, turn on the Bash sandbox and set allowUnsandboxedCommands to false in ~/.claude/settings.json or .claude/settings.local.json.

Decisions happen in Telegram or on the web dashboard (https://oked.ai/dashboard). The iPhone app is coming soon.

OKed would have paused 9 of these commands, including 3 rm -rf / file delete, 2 force-pushes and 2 prod deploys.
Get a yes/no in Telegram before your agent runs them:
  npm install -g @oked/claude-code @oked/codex && oked init && oked-codex init
https://oked.ai
```

An empty home, with no transcript directory, says that no history was found. It does not print a zero table, and it does not invent a paused count.

<!-- empty-report -->
```
OKed scan 0.6.25
Local only. This scan does not use the network and does not send telemetry.

Claude Code   no transcripts at ~/.claude/projects
Codex CLI     no sessions at ~/.codex/sessions
Window        all history

No Claude Code or Codex history was found at the paths checked.
Pass --path <dir> to read a different directory.

Decisions happen in Telegram or on the web dashboard (https://oked.ai/dashboard). The iPhone app is coming soon.

Get a yes/no in Telegram before your agent runs a risky command:
  npm install -g @oked/claude-code && oked init
https://oked.ai
```

## License

[Apache-2.0](./LICENSE)
