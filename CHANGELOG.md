# Changelog

All `@oked/*` packages share one version. This file notes behavior changes that are not yet in a tagged release, then the notes for each tag.

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Unreleased

### @oked/ai-sdk

- New package, not on npm yet. The first publish is by hand (see RELEASING.md). `okedToolApproval()` is the AI SDK 7 `toolApproval` callback for `generateText`, `streamText`, and `ToolLoopAgent`. A denial or a timeout comes back as `{ type: "denied", reason }`, and the tool does not run. `withOked()` wraps one tool's `execute`. `okedTools()` wraps a tools object. Those wrappers also cover AI SDK 5 and 6.

### Docs

- Public docs no longer document the backend URL override, either as an environment variable or as a config option. OKed is hosted only at `api.oked.ai`. Code behavior is unchanged.

### @oked/hook-core

- New package, on npm (`npm install @oked/hook-core`). `decide()` classifies a tool call, waits for a person, checks the signed receipt, and fails closed. `HOOK_TIMEOUT_SECONDS` is 690, which is 60 seconds above the SDK wait of 630. There is no init command.
- `@oked/claude-code` calls that gate. Claude's stdin and stdout, the unpaired `ask`, and `oked init` are unchanged.

### @oked/codex

- New package, on npm. `oked-codex init` writes a `PreToolUse` hook to `.codex/hooks.json` with timeout 690 and matcher `*`. Install with `npm install -g @oked/codex`, then `oked-codex init`.
- An allow prints nothing, because Codex treats an explicit allow as unsupported. An unpaired device is denied with `Pair first: run oked-codex init`. A hook timeout or a crash still fails open inside Codex. Trust the hook with `/hooks`.

### @oked/cursor

- New package, on npm. `oked-cursor init` writes `.cursor/hooks.json` with `timeout` 690 and `failClosed: true`. Install with `npm install -g @oked/cursor`, then `oked-cursor init`. Cursor does not document the timeout maximum.
- If Claude settings already contain `oked-hook`, init does not add a second hook. `--native` installs anyway.
- Unpaired devices are denied. `ask` is not used, because Cursor does not enforce it on `preToolUse`.

### @oked/copilot

- New package, on npm. `oked-copilot init` writes `.github/hooks/oked.json` with `timeoutSec` 690 for the CLI, VS Code, and the cloud agent. Install with `npm install -g @oked/copilot`, then `oked-copilot init`.
- Timeouts fail open. Crashes and non-zero exits deny. VS Code hooks are Preview. A cloud job needs `api.oked.ai` allowlisted, and the wait counts against the job timeout.
- A project Claude Code `oked-hook` makes init skip the native file. `--native` installs anyway. `~/.claude/settings.json` is not read by Copilot.

### @oked/claude-code

- The README links to `https://oked.ai/dashboard` and `https://oked.ai/docs#verify`. The `?ref=` tracking parameters are gone.

### @oked/langgraph

- New package (not on npm yet; the first publish is by hand, see [RELEASING.md](./RELEASING.md)). `withOkedApproval` and `withOkedApprovals` wrap LangChain tools so a risky call waits on `approve()` before it runs. Pass the wrapped tools to `ToolNode` or `createReactAgent`. A denial, a timeout, a bad receipt, or an unexpected error returns an error tool result and does not run the tool. Install with `npm install @oked/langgraph`. The gate does not use LangGraph `interrupt()`.

## 0.6.21

- `@oked/hook-core`, `@oked/codex`, `@oked/cursor`, and `@oked/copilot` are on npm at 0.6.21. Each has a Trusted Publisher (`oked-ai` / `oked-sdk` / `publish.yml`). Codex: `npm install -g @oked/codex`, then `oked-codex init`. Cursor: `npm install -g @oked/cursor`, then `oked-cursor init`. Copilot: `npm install -g @oked/copilot`, then `oked-copilot init`. `@oked/hook-core` is `npm install @oked/hook-core` and has no init command.
- Tagged release of the packages that were already on npm. See the git history for the classifier and receipt fixes in that tag.
