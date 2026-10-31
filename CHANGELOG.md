# Changelog

All `@oked/*` packages share one version. This file notes behavior changes that are not yet in a tagged release, then the notes for each tag.

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Unreleased

### Watch mode

- `mode` is `watch` or `enforce`. The default is `enforce`, so an existing install still pauses risky actions until you approve.
- Set it in `~/.oked/config.json`, with `OKED_MODE` (that wins over the file), or with `oked init --mode watch`. On a terminal, `oked init` asks when no mode is set. A non-interactive run with no choice stays on enforce and does not change the file. `oked-codex init`, `oked-cursor init`, `oked-copilot init`, and `oked-openclaw init` offer the same choice.
- In watch mode the Claude Code, Codex, Cursor, and Copilot hooks, the OpenClaw plugin, the Claude Agent SDK hook, and the AI SDK, OpenAI Agents, and LangGraph adapters (JavaScript and Python) allow a call they would have paused. They append one line to `~/.oked/watch.log`. `oked report` summarizes it. The other host CLIs have the same `report` command. The Claude Code plugin hook uses the same gate.
- The line stores the time, tool name, tier, client, source, and `would have paused` (or `would have paused (not paired)` or `would have paused (saved rule)`). It does not store the command, tool arguments, description, working directory, session id, or API key.
- Watch mode does not send the action. There is no endpoint that records a would-have-paused event without holding the action for a decision, so nothing is posted for approval. A presence ping may still be sent when a key is set. That ping is the machine hostname only. A rules fetch for a safe or warning action may still run and does not include the action.
- A classifier failure, an unreadable hook payload, and an internal error still deny. `approve()` on the client still waits. Watch mode applies to the automatic gates.
- See [docs/watch.md](./docs/watch.md).

### Claude Code plugin

- OKed can be installed as a Claude Code plugin. In Claude Code: `/plugin marketplace add oked-ai/oked-sdk`, then `/plugin install oked@oked`. The marketplace name is `oked` and the plugin name is `oked`. No global npm install is required.
- The hook is `plugins/claude-code/scripts/oked-hook.mjs`, a readable bundle of the hook and the SDK, run with `node`. The matcher is `Bash|Write|Edit|Agent|mcp__.*` and the timeout is 690 seconds. `node scripts/build-claude-plugin.mjs` rebuilds it. CI fails if the committed file is stale or larger than 256 KiB. `npm run bump` sets the plugin version to the same number as the packages and rebuilds the bundle.
- Pair with `/oked:pair`. The plugin API key is sensitive. The hook reads `CLAUDE_PLUGIN_OPTION_APIKEY`. Until a key is saved, a risky action returns `ask`.
- If the plugin is enabled and `oked init` has also installed `oked-hook`, only the plugin calls OKed. The settings hook returns allow. `oked init` does not add a settings hook while the plugin is enabled. `oked uninstall` removes the project entry. If you disable the plugin, that entry gates again.

### @oked/openclaw

- Install from ClawHub, which is what `openclaw plugins install` checks first: `openclaw plugins install @oked/openclaw`. Pairing still uses `@oked/openclaw-cli` (`npm install -g @oked/openclaw-cli`, then `oked-openclaw init`).
- A `v*` tag publishes this package to ClawHub when the `CLAWHUB_TOKEN` secret is set. If the secret is missing, that step logs a skip line and the npm publish still succeeds. The one-time setup (`clawhub login`, the `oked` publisher handle, the first manual publish, the trusted publisher, and `CLAWHUB_TOKEN`) is in [RELEASING.md](./RELEASING.md).
- The catalog category is `security`. The package ships `assets/icon.png` for the ClawHub listing.

### @oked/claude-code and @oked/sdk

- Opaque code runners now ask for approval on Claude Code when the Bash sandbox is not containing child processes. The hook only sees the runner command. A test or script can run `rm` (or anything else) without a second tool call. That is what happened in [anthropics/claude-code#105342](https://github.com/anthropics/claude-code/issues/105342): `cargo test` ran `rm -rf ~` and the hook never saw the `rm`. The tier for these runners is `review`.
- The runners are `cargo test`, `npm test` / `npm run <script>` (and `pnpm` / `yarn` / `bun` equivalents, including `yarn <script>` and `pnpm <script>`), `pytest` and `python -m pytest`, `go test`, `make` and `make <target>`, `./script.sh`, `bash script.sh` / `sh script.sh`, `node <script>` (for example `node scripts/x.mjs`), and `npx <tool>` (also `bunx`, `npm exec`, `pnpm dlx`). Env prefixes (`FOO=bar npm test`), `env`, and compound commands (`cd pkg && cargo test`) count. A higher tier still wins: `cargo test && rm -rf ~` stays `high_stakes`.
- They stay `safe` when Claude Code's sandbox is on and `allowUnsandboxedCommands` is `false`. The hook reads `.claude/settings.local.json`, `.claude/settings.json`, and `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR` moves the user file). A user `false` holds against a project `true`, matching Claude Code. `sandbox.filesystem.disabled: true` in user settings is not containment. A command listed in `sandbox.excludedCommands` is not contained when the pattern covers every part of the command.
- To skip the prompts, put this in `~/.claude/settings.json` or `.claude/settings.local.json`:

  ```json
  { "sandbox": { "enabled": true, "allowUnsandboxedCommands": false } }
  ```

- `oked init` prints that hint when the sandbox is not already enforcing it. The approval card footnote says the same.
- Reads, ordinary commands, `npm install`, and local git stay as they were. Inline `node -e` / `python -c` stay `safe` (the body is in the command string). Other hosts do not read Claude Code sandbox settings, so these runners stay `safe` there unless the caller passes `classify(..., { sandboxEnforced: false })`.

### Docs

- The Python `oked` README no longer says version `0.6.21` is the same number as the `@oked/*` packages. The version is set in `pyproject.toml` and later publishes use a separate `py-v*` tag.

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
