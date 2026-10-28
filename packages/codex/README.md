# @oked/codex

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

Codex CLI hook. Sensitive actions wait for a person in Telegram or on the [web dashboard](https://oked.ai/dashboard?ref=github-codex) before Codex continues. The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

Safe actions are allowed by the hook, with no notification. Warning actions are allowed and logged. OKed asks only for `review` and `high_stakes`.

## Install

`@oked/codex` is not on npm yet. It ships with the next tagged release. `@oked/hook-core`, which it depends on, is not on npm yet either.

After the release:

```bash
npm install -g @oked/codex
npx oked-codex init
```

From a clone, until that release:

```bash
git clone https://github.com/oked-ai/oked-sdk.git
cd oked-sdk
npm install
npm run build
npm install -g ./packages/codex
oked-codex init
```

The root `npm install` links `@oked/hook-core` from this repo. `npm install -g ./packages/codex` links the command to the clone, so leave the clone and its `node_modules` in place.

`oked-codex init` (the same command as `npx oked-codex init` after the npm release) writes `.codex/hooks.json` in the current project and stores the API key in `~/.oked/config.json`. The file it writes:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "oked-codex-hook", "timeout": 690 }
        ]
      }
    ]
  }
}
```

The matcher is `*`, so every local tool is included. Other hooks already in that file are kept. A second init does not add a second copy. It raises a timeout below 690 and removes `async: true`. The binary is `oked-codex`, not `oked`, so it can sit next to `@oked/claude-code`.

Then, in Codex, run `/hooks` and trust the hook. Codex remembers that trust against the hook hash. Run `/hooks` again after `oked-codex init` changes the timeout or the command.

The approval window is 10 minutes. The hook process is allowed 690 seconds, and the SDK client waits 630 seconds, so a timeout becomes a deny instead of Codex killing the hook first.

## Commands

| Command | What it does |
|---|---|
| `oked-codex init` | Install or update the project hook and pair this device. Run it again after you update the package. |
| `oked-codex init --no-browser` | Print the pairing link. Do not open a browser, and do not touch the clipboard. |
| `oked-codex init --yes` (or `-y`) | Skip the "press Enter to open the browser" prompt. For a non-interactive shell. |
| `oked-codex status` | Show install state and ping `GET /health` on the backend. |
| `oked-codex uninstall` | Remove the project hook entry. Other hooks in `.codex/hooks.json` are kept. |

## What gets intercepted

The hook uses the same four-tier classifier as `@oked/claude-code`. Classification is effect-based. Reads and commands with no detected side effect are `safe`. Reversible local changes are `warning` (allowed, and logged). Destructive, irreversible, or outward-facing actions are `review` or `high_stakes` and wait for a person.

Codex tool names are mapped onto that classifier before the decision:

| Codex tool | OKed sees | Notes |
|---|---|---|
| `Bash`, `exec_command`, `shell_command`, `local_shell` | `Bash` | Shell, network, and deploy commands use the bash rules. `ls` and `git status` are safe. `rm` of a real file, a force push, and a production deploy wait. |
| `apply_patch` | `Write` or `rm` | A delete in the patch is classified as `rm`. A write is `warning` unless the path is sensitive (`/etc`, `~/.ssh`, shell rc, OKed config), which is `review`. |
| `mcp__server__tool` | the same name | `list_*` and `get_*` are safe. `create_*`, `send_*`, and `update_*` are `review`. `delete_*`, `drop_*`, and `remove_*` are `high_stakes`. |
| `spawn_agent` | `Agent` | Starting a sub-agent is safe. Its own tool calls are gated on their own. |
| anything else | the same name | Unknown tools are `review`. They wait for approval. |

Hosted tools such as web search do not run this hook. Codex does not send them through `PreToolUse`.

## How it works

1. Codex runs `oked-codex-hook` before the tool call. The hook is a separate process. The matcher is `*`, so every local tool is included.
2. The hook classifies the action locally. `safe` and `warning` do not wait on the network, unless a cached user rule matches.
3. For `review` and `high_stakes`, it sends an approval request.
4. You decide in Telegram or on the web dashboard. Web push is optional.
5. Approve, and the hook prints nothing. Codex treats empty output as success and continues. Deny or time out, and the hook prints `permissionDecision: "deny"` with the reason.

An explicit `permissionDecision: "allow"` without `updatedInput` is not a normal allow in Codex. The current source marks it unsupported and still runs the tool (`permission_decision_allow_without_updated_input_fails_open` in `codex-rs/hooks/src/events/pre_tool_use.rs`). This hook never prints `allow`, and it never prints `ask`. `ask` is unsupported in the same way, and the tool would continue.

If this device is not paired, the hook denies. The reason is `Pair first: run oked-codex init`. It does not fail open.

## Timeout

Codex measures `timeout` in seconds. The default is 600. In `normalize_command_hook` (`codex-rs/hooks/src/engine/discovery.rs`) every event except `SessionEnd` and `Interrupt` uses `timeout_sec.unwrap_or(600).max(1)`. There is no upper cap. `SessionEnd` and `Interrupt` are capped at 3 seconds. This package does not install those events.

`oked-codex init` sets `timeout` to 690. It raises a lower value. A higher value you set yourself is left alone. It also removes `async: true`. An async hook runs in the background and does not wait for the decision.

Docs: [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks). Source checked on 2026-10-28: [discovery.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs) and [pre_tool_use.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs).

## Limits

Codex describes hooks as a useful guardrail, not a complete enforcement boundary. A callback error, a timeout, or malformed output fails open: the tool runs. The 690 second timeout is what keeps the SDK's own deny inside the window Codex will wait. If a future Codex build caps the timeout below 630 seconds, that deny would not be written, and the call would fail open. No such cap is in the source above.

Command hooks do not run in Codex cloud. `write_stdin` on a shell that already passed `PreToolUse` does not run the hook again.

## Environment

| Var | Required | Description |
|---|---|---|
| `OKED_API_KEY` | no, after pairing | Optional override. `oked-codex init` stores the paired key in `~/.oked/config.json`. |
| `OKED_BACKEND_URL` | no | Override the hosted backend URL. |
| `OKED_STRICT_FAIL_CLOSED` | no | `1` or `true` denies every sensitive action when the backend is unreachable. |
| `OKED_REQUIRE_RECEIPT` | no | `0` allows an approval with no receipt. On by default since 0.6.0. |
| `OKED_HOOK_LOG` | no | Decision log path. Default `~/.oked/hook.log`. |

## Receipts

Every decision comes with a receipt signed by OKed. The hook verifies it before allowing the action and keeps a copy in `~/.oked/receipts.jsonl`. Since 0.6.0 the hook denies an approval that has no valid receipt. Set `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts.

You can paste one receipt at [oked.ai/docs/#verify](https://oked.ai/docs?ref=github-codex#verify), or check an export with `npx @oked/verify`. `oked receipts verify` from `@oked/claude-code` checks the same file. See [docs/receipts.md](../../docs/receipts.md).

## Degraded-mode behavior

Explicit denials, invalid API keys, and receipts that do not verify deny the action. If the backend is unreachable, OKed denies `high_stakes` and, by default, allows lower tiers. Set `OKED_STRICT_FAIL_CLOSED=1` to deny every sensitive action during an outage.

HTTP 429 (too many approvals already waiting) is not an outage: the action is denied until those are decided in Telegram or on the dashboard.

If the hook cannot parse its stdin, it denies. A bad payload must not become a silent allow.

## Decision log

The hook writes one JSON line to `~/.oked/hook.log` (mode 600) for each deny, and for each degraded allow. The log never holds the tool input or the command.

## Double prompts

Codex does not load `~/.claude/settings.json` or a project `.claude/settings.json`. There is no `--native` flag, because a Claude Code hook does not also run inside Codex. Installing both packages asks once in each tool, not twice in Codex.

## Uninstall

`oked-codex uninstall` removes only the `oked-codex-hook` entry. Other hooks in `.codex/hooks.json` stay. If that was the only content, the file is deleted. The API key in `~/.oked/config.json` stays, so Claude Code and the other hooks keep working. Run `/hooks` in Codex if it still lists a hook you removed. Trust is stored by Codex, not by this file alone.

## Troubleshooting

- Nothing happens: the hook is not trusted yet. Run `/hooks` in Codex and trust it. A changed timeout changes the hash, so trust it again.
- Risky command ran with no card: the hook timed out, crashed, or printed bad JSON. Codex fails open in those cases. Confirm `timeout` is 690. Do not set `async`.
- `Pair first: run oked-codex init`: this machine has no API key. Run that command. It does not silently allow the call.
- Backend down: `high_stakes` is denied. Lower tiers are allowed unless `OKED_STRICT_FAIL_CLOSED=1`. A decision of `timeout` (nobody answered in 10 minutes) is a deny.
- Codex cloud: command hooks do not run there. Hosted tools such as web search are not sent to `PreToolUse`.
- Still stuck: [contact@oked.ai](mailto:contact@oked.ai).

## License

[Apache-2.0](./LICENSE)
