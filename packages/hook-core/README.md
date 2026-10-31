# @oked/hook-core

[![npm version](https://img.shields.io/npm/v/@oked/hook-core.svg)](https://www.npmjs.com/package/@oked/hook-core)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/hook-core.svg)](./LICENSE)

Shared gate for OKed coding-agent hooks. It is the part of [`@oked/claude-code`](../claude-code) that does not depend on Claude Code: classify the tool call, build the approval request, wait for a person, check the signed receipt, and fail closed.

Host packages read the host's payload, map tool names, call `decide()`, and write the host's own allow or deny output. `@oked/claude-code` does this with unchanged behavior. `@oked/codex`, `@oked/cursor`, and `@oked/copilot` do it for those hosts.

## Install

```bash
npm install @oked/hook-core
```

This package has no `init` command. Install a host package (`@oked/claude-code`, `@oked/codex`, `@oked/cursor`, or `@oked/copilot`) unless you are building a hook.

Decisions are made in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## What `decide()` does

1. Classify the call with `@oked/sdk`. `safe` returns allow, with no notification. `warning` returns allow and writes a terminal line. A cached user rule that matches either tier sends the call to the backend instead. For `source: "claude-code"`, an opaque runner (`cargo test`, `npm test`, a script file, `npx`) is `review` unless Claude Code's Bash sandbox is on with `allowUnsandboxedCommands: false`. Other sources leave those commands `safe`.
2. With no API key, return the host's unpaired decision. Claude Code asks the host's own prompt. A host that cannot enforce `ask` should deny, and the reason should say `Pair first`.
3. For `review` and `high_stakes`, send the approval and wait. The SDK waits 630 seconds (`DEFAULT_APPROVAL_TIMEOUT_MS`), which is 30 seconds past the backend's 10 minute window.
4. An approval counts only when the signed receipt verifies. The hook keeps a copy in `~/.oked/receipts.jsonl`.
5. An explicit denial, a bad key, a bad receipt, HTTP 429, and any unexpected error deny. If the backend is unreachable, `high_stakes` denies and lower tiers allow, unless `OKED_STRICT_FAIL_CLOSED` is set. A backend `decision` of `timeout` denies.

`HOOK_TIMEOUT_SECONDS` is 690. A host that can set a hook timeout must set it at least that high, so the SDK's deny is written before the host kills the process. A killed hook prints nothing, and most hosts then let the tool call continue. Cursor can also set `failClosed` so a killed hook denies. Codex and Copilot fail open on timeout, and their installers still set 690 so the SDK finishes first when the host honors it.

## Tool names

`classify()` knows Claude Code names (`Bash`, `Write`, `Edit`, `mcp__server__tool`). Host packages map their own names onto those before calling `decide()`. Unknown names stay unknown, and the classifier treats an unknown tool as `review` (approval required). `mapPatch()` and `mapFileDelete()` turn patches and deletes into the same effect classes the bash classifier already uses.

`findClaudeOkedHooks()` reports an existing `oked-hook` entry in Claude settings. A host that also loads those files uses it so one action is not asked twice. The Claude Code plugin uses the same check. When that plugin is enabled and its hook file is installed, the settings hook returns allow and the plugin is the only gate. When the plugin is not the gate, the plugin hook returns allow for tools the settings hook already matches.

## Troubleshooting

- No API key: `decide()` returns the unpaired decision. It does not silently allow a risky call.
- Backend down: `high_stakes` denies. Lower sensitive tiers allow unless `OKED_STRICT_FAIL_CLOSED=1`.
- Receipt missing or invalid: the approval is denied. `OKED_REQUIRE_RECEIPT=0` is only for a backend that does not sign receipts.
- Hook killed before it prints: the host's own timeout is below 690, or the host failed open. Raise the host timeout. On Cursor, set `failClosed`.

## License

[Apache-2.0](./LICENSE)
