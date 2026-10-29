# Changelog

All `@oked/*` packages share one version. This file notes behavior changes that are not yet in a tagged release, then the notes for each tag.

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Unreleased

### Python (`oked` and `oked-langgraph`)

- New Python packages, not on PyPI yet. The first publish of each is by hand (see RELEASING.md). `pip install oked` is the Python client (`OkedClient.approve()`). `pip install oked-langgraph` is the Python LangGraph and LangChain integration (`with_oked_approvals`). These are not the Node.js `@oked/sdk` and `@oked/langgraph` packages. A denial or a timeout does not run the tool. Later publishes use a `py-v*` tag.

## 0.6.22

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon.

- New since v0.6.21: `@oked/langgraph`, `@oked/ai-sdk`, and `@oked/openai-agents`. Each was first published by hand at 0.6.21. This tag publishes 0.6.22 with the other packages. Confirm the Trusted Publisher on each before tagging (see [RELEASING.md](./RELEASING.md)).
- New `@oked/hook-core` shared gate, on npm. Codex, Cursor, and GitHub Copilot hooks call it. `@oked/claude-code` now calls it too. Claude's stdin and stdout, the unpaired `ask`, and `oked init` are unchanged.
- README fixes. The Claude Code README no longer uses `?ref=` tracking links. Public docs no longer document a backend URL override. OKed is hosted only at `api.oked.ai`. Code behavior is unchanged.

### @oked/ai-sdk

- `okedToolApproval()` is the AI SDK 7 `toolApproval` callback for `generateText`, `streamText`, and `ToolLoopAgent`. A denial or a timeout comes back as `{ type: "denied", reason }`, and the tool does not run. `withOked()` wraps one tool's `execute`. `okedTools()` wraps a tools object. Those wrappers also cover AI SDK 5 and 6. Install with `npm install @oked/ai-sdk`.

### @oked/openai-agents

- `okedTool()` wraps one function tool. `withOkedTools()` wraps a tool list. Local shell, apply_patch, and hosted MCP use the Agents SDK approval callback. A denial, a timeout, or an error is returned to the model and the tool does not run. Install with `npm install @oked/openai-agents`.

### @oked/hook-core

- `decide()` classifies a tool call, waits for a person, checks the signed receipt, and fails closed. `HOOK_TIMEOUT_SECONDS` is 690, which is 60 seconds above the SDK wait of 630. There is no init command. Install with `npm install @oked/hook-core`.

### @oked/codex

- `oked-codex init` writes a `PreToolUse` hook to `.codex/hooks.json` with timeout 690 and matcher `*`. Install with `npm install -g @oked/codex`, then `oked-codex init`.
- An allow prints nothing, because Codex treats an explicit allow as unsupported. An unpaired device is denied with `Pair first: run oked-codex init`. A hook timeout or a crash still fails open inside Codex. Trust the hook with `/hooks`.

### @oked/cursor

- `oked-cursor init` writes `.cursor/hooks.json` with `timeout` 690 and `failClosed: true`. Install with `npm install -g @oked/cursor`, then `oked-cursor init`. Cursor does not document the timeout maximum.
- If Claude settings already contain `oked-hook`, init does not add a second hook. `--native` installs anyway.
- Unpaired devices are denied. `ask` is not used, because Cursor does not enforce it on `preToolUse`.

### @oked/copilot

- `oked-copilot init` writes `.github/hooks/oked.json` with `timeoutSec` 690 for the CLI, VS Code, and the cloud agent. Install with `npm install -g @oked/copilot`, then `oked-copilot init`.
- Timeouts fail open. Crashes and non-zero exits deny. VS Code hooks are Preview. A cloud job needs `api.oked.ai` allowlisted, and the wait counts against the job timeout.
- A project Claude Code `oked-hook` makes init skip the native file. `--native` installs anyway. `~/.claude/settings.json` is not read by Copilot.

### @oked/claude-code

- Built on `@oked/hook-core`. The README links to `https://oked.ai/dashboard` and `https://oked.ai/docs#verify`.

### @oked/langgraph

- `withOkedApproval` and `withOkedApprovals` wrap LangChain tools so a risky call waits on `approve()` before it runs. Pass the wrapped tools to `ToolNode` or `createReactAgent`. A denial, a timeout, a bad receipt, or an unexpected error returns an error tool result and does not run the tool. Install with `npm install @oked/langgraph`. The gate does not use LangGraph `interrupt()`.
- On Node 18, LangGraph 1.5 expects a global `crypto`. Set `globalThis.crypto = require("node:crypto").webcrypto` before you build a `ToolNode`, or use the ESM equivalent: `import { webcrypto } from "node:crypto"` and then `globalThis.crypto = webcrypto`. Node 20 or newer already has that global.

## 0.6.21

- `@oked/hook-core`, `@oked/codex`, `@oked/cursor`, and `@oked/copilot` are on npm at 0.6.21. Each has a Trusted Publisher (`oked-ai` / `oked-sdk` / `publish.yml`). Codex: `npm install -g @oked/codex`, then `oked-codex init`. Cursor: `npm install -g @oked/cursor`, then `oked-cursor init`. Copilot: `npm install -g @oked/copilot`, then `oked-copilot init`. `@oked/hook-core` is `npm install @oked/hook-core` and has no init command.
- Tagged release of the packages that were already on npm. See the git history for the classifier and receipt fixes in that tag.
