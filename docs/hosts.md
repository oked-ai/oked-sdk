# Supported hosts

OKed stops a risky tool call until a person decides in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Contact is [contact@oked.ai](mailto:contact@oked.ai).

| Host | Package | Install |
|---|---|---|
| Claude Code | [`@oked/claude-code`](../packages/claude-code) | `npm install -g @oked/claude-code`, then `oked init`. Writes `.claude/settings.json`. Or, with no global install, `/plugin marketplace add oked-ai/oked-sdk`, `/plugin install oked@oked`, then `/oked:pair`. See [plugins/claude-code](../plugins/claude-code). Unpaired devices return `ask`. The gate is `@oked/hook-core`. If the plugin and the settings hook are both installed, only the plugin calls OKed. Test runners and script files ask for approval unless the Bash sandbox is on with `allowUnsandboxedCommands` set to false. |
| Codex CLI | [`@oked/codex`](../packages/codex) | `npm install -g @oked/codex`, then `oked-codex init`. Writes `.codex/hooks.json` with timeout 690. Run `/hooks` and trust the hook. Timeouts fail open. An allow prints nothing. |
| Cursor | [`@oked/cursor`](../packages/cursor) | `npm install -g @oked/cursor`, then `oked-cursor init`. Writes `.cursor/hooks.json` with timeout 690 and `failClosed: true`. The real timeout ceiling is not documented. Skips install when a Claude Code hook would also run. `--native` installs anyway. |
| GitHub Copilot CLI and VS Code | [`@oked/copilot`](../packages/copilot) | `npm install -g @oked/copilot`, then `oked-copilot init`. Writes `.github/hooks/oked.json` with `timeoutSec` 690. Timeouts fail open. VS Code hooks are Preview. The cloud agent needs `api.oked.ai` allowlisted. Skips install when a project Claude Code hook would also run. |
| Claude Agent SDK | [`@oked/claude-agent-sdk`](../packages/claude-agent-sdk) | `npm install @oked/claude-agent-sdk`, then pass `okedHooks()`. |
| Vercel AI SDK | [`@oked/ai-sdk`](../packages/ai-sdk) | `npm install @oked/ai-sdk`, then pass `okedToolApproval()` as `toolApproval` on `generateText`, `streamText`, or `ToolLoopAgent`. |
| OpenAI Agents SDK | [`@oked/openai-agents`](../packages/openai-agents) | `npm install @oked/openai-agents`, then wrap tools with `okedTool()` or `withOkedTools()`. A denial is the tool result. |
| OpenClaw | [`@oked/openclaw`](../packages/openclaw) | `openclaw plugins install npm:@oked/openclaw`, then `npm install -g @oked/openclaw-cli` and `oked-openclaw init` to pair. Once the package is listed on ClawHub, `openclaw plugins install @oked/openclaw` installs it from there. Requires OpenClaw 2026.5.4 or newer. |
| LangGraph.js and LangChain tools | [`@oked/langgraph`](../packages/langgraph) | `npm install @oked/langgraph`, then `withOkedApprovals(tools)` on the list you pass to `ToolNode` or `createReactAgent`. A denial or a timeout does not run the tool. This does not use LangGraph `interrupt()`. |
| LangGraph and LangChain (Python) | [`oked-langgraph`](../python/oked-langgraph) | Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked" "oked-langgraph @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked-langgraph"`. Once it is on PyPI, `pip install oked-langgraph`. Then `with_oked_approvals(tools)` on the list you pass to `ToolNode` or `create_react_agent`. A denial or a timeout does not run the tool. This does not use LangGraph `interrupt()`. Python 3.10 or newer. |
| Any Python agent | [`oked`](../python/oked) | Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked"`. Once it is on PyPI, `pip install oked`. Then call `approve()`. Python 3.9 or newer. |
| NVIDIA OpenShell | [oked-openshell](https://github.com/oked-ai/oked-openshell) | Separate repo. `oked init --key-only` creates a key and does not install the Claude Code hook. |
| Any Node.js agent | [`@oked/sdk`](../packages/sdk) | `npm install @oked/sdk`, then call `approve()`. |

[`@oked/hook-core`](../packages/hook-core) is the shared gate those hooks call (`npm install @oked/hook-core`). It has no `init` command. Do not install it on its own unless you are building a host package.

Claude Code is the host that reads sandbox settings (`.claude/settings.json`, `.claude/settings.local.json`, and `~/.claude/settings.json`). When `sandbox.enabled` is true and `allowUnsandboxedCommands` is false, `cargo test`, `npm test`, `npm run`, `pytest`, `go test`, `make`, `./script.sh`, and `npx` stay allowed, because child processes cannot write outside the working directory. Otherwise those commands ask (`review`). Codex, Cursor, Copilot, and the SDK hosts do not read those files, so the same commands stay allowed there.

The hook timeout hosts should set, when they allow it, is 690 seconds (`HOOK_TIMEOUT_SECONDS`). That sits above the SDK wait of 630 seconds.

## Local audit

[`@oked/scan`](../packages/scan) does not install a hook. `npx @oked/scan` reads Claude Code transcripts and Codex CLI sessions that are already on this machine and prints which commands the default rules would have paused. It does not use the network and it does not send telemetry. A missing directory is skipped.

It ends with how many commands would have paused, the install command for the history it found (`npm install -g @oked/claude-code && oked init`, and `oked-codex init` when Codex history is present), and https://oked.ai. If nothing would have paused, it says so and does not invent a count. Claude Code can also be installed with no global package: `/plugin marketplace add oked-ai/oked-sdk`, then `/plugin install oked@oked`, then `/oked:pair`. Decisions happen in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon.
