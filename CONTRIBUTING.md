# Contributing

Questions and security reports go to [contact@oked.ai](mailto:contact@oked.ai). Do not send vulnerability reports to a personal address. The iPhone app is coming soon. People decide in Telegram and on the [web dashboard](https://oked.ai/dashboard).

## Layout

| Path | What it is |
|---|---|
| [packages/sdk](./packages/sdk) | `OKedClient.approve()` and the classifier |
| [packages/hook-core](./packages/hook-core) | Shared hook gate. `npm install @oked/hook-core`. Host packages call `decide()` |
| [packages/claude-code](./packages/claude-code) | Claude Code `PreToolUse` hook. `oked init` |
| [packages/codex](./packages/codex) | Codex CLI hook. `npm install -g @oked/codex`, then `oked-codex init` |
| [packages/cursor](./packages/cursor) | Cursor hook. `npm install -g @oked/cursor`, then `oked-cursor init` |
| [packages/copilot](./packages/copilot) | Copilot CLI and VS Code hook. `npm install -g @oked/copilot`, then `oked-copilot init` |
| [packages/claude-agent-sdk](./packages/claude-agent-sdk) | Programmatic hook for the Claude Agent SDK |
| [packages/ai-sdk](./packages/ai-sdk) | Vercel AI SDK. `okedToolApproval()`, `withOked()`, `okedTools()` |
| [packages/openai-agents](./packages/openai-agents) | OpenAI Agents SDK tools. `okedTool()`, `withOkedTools()`, or `settleOkedInterruptions()` |
| [packages/openclaw](./packages/openclaw) | OpenClaw plugin |
| [packages/langgraph](./packages/langgraph) | LangChain tool wrapper for LangGraph `ToolNode` and `createReactAgent`. `npm install @oked/langgraph` |
| [python/oked](./python/oked) | Python client. Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked"`. Once it is on PyPI, `pip install oked`. Python 3.9 or newer. |
| [python/oked-langgraph](./python/oked-langgraph) | Python LangGraph and LangChain wrapper. Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked" "oked-langgraph @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked-langgraph"`. Once it is on PyPI, `pip install oked-langgraph`. Python 3.10 or newer. |
| [packages/receipt-core](./packages/receipt-core) | Receipt format |
| [packages/verify](./packages/verify) | Offline export check |
| [docs/hosts.md](./docs/hosts.md) | Which agents are covered |
| [docs/receipts.md](./docs/receipts.md) | Receipt fields |
| [RELEASING.md](./RELEASING.md) | How a version is published |

Supported agents are listed in [docs/hosts.md](./docs/hosts.md) and in the root README quick start.

## Checks

Node.js 18 or newer.

```bash
npm install
npm run build
npm test
```

`npm test` runs every workspace that has a test script. CI (`.github/workflows/ci.yml`) runs that on Node.js 18 and 22, then `npm pack --dry-run` for every package. A package without a `test` script fails CI. The same workflow runs the Python tests: `oked` on Python 3.9 and 3.12, and `oked-langgraph` on 3.12.

```bash
pip install -e "python/oked[dev]"
pytest python/oked/tests
pip install -e "python/oked-langgraph[dev]"
pytest python/oked-langgraph/tests
```

Do not use an em dash in docs or in user-facing copy.

## A new host package

Match the existing packages: `package.json` name `@oked/<host>`, version locked to the rest, `engines.node` `>=18`, `license` `Apache-2.0`, `publishConfig.access` `public`, `files` limited to what ships, `repository.directory` set, `bugs` pointing at this repo's issues, `homepage` `https://oked.ai`. Keywords include `oked`, `ai-agent`, `approval`, `human-in-the-loop`, and `hooks`.

The hook binary calls `decide()` from `@oked/hook-core`. Set the host timeout to `HOOK_TIMEOUT_SECONDS` (690) when the host allows it. Unknown tool names require approval. An unpaired device denies, with `Pair first: run <command> init`, except Claude Code, which still returns `ask`.

Add the package to `publish.yml`, [RELEASING.md](./RELEASING.md), [docs/hosts.md](./docs/hosts.md), and the root README. The first npm publish is by hand, then a Trusted Publisher. Do not publish from a pull request.
