<h1 align="center">OKed</h1>

<p align="center">
  <b>Risky agent actions wait for a person. Safe ones run.</b><br/>
  OKed pauses risky actions from AI coding agents and asks for a yes or no before they run.
</p>

<p align="center">
  <a href="https://oked.ai">oked.ai</a> &middot;
  <a href="https://oked.ai/docs">Docs</a> &middot;
  <a href="#quick-start">Quick start</a> &middot;
  <a href="#packages">Packages</a> &middot;
  <a href="#receipts">Receipts</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oked/sdk"><img src="https://img.shields.io/npm/v/@oked/sdk?label=%40oked%2Fsdk" alt="@oked/sdk on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/hook-core"><img src="https://img.shields.io/npm/v/@oked/hook-core?label=%40oked%2Fhook-core" alt="@oked/hook-core on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/claude-code"><img src="https://img.shields.io/npm/v/@oked/claude-code?label=%40oked%2Fclaude-code" alt="@oked/claude-code on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/codex"><img src="https://img.shields.io/npm/v/@oked/codex?label=%40oked%2Fcodex" alt="@oked/codex on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/cursor"><img src="https://img.shields.io/npm/v/@oked/cursor?label=%40oked%2Fcursor" alt="@oked/cursor on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/copilot"><img src="https://img.shields.io/npm/v/@oked/copilot?label=%40oked%2Fcopilot" alt="@oked/copilot on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/claude-agent-sdk"><img src="https://img.shields.io/npm/v/@oked/claude-agent-sdk?label=%40oked%2Fclaude-agent-sdk" alt="@oked/claude-agent-sdk on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/ai-sdk"><img src="https://img.shields.io/npm/v/@oked/ai-sdk?label=%40oked%2Fai-sdk" alt="@oked/ai-sdk on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/openai-agents"><img src="https://img.shields.io/npm/v/@oked/openai-agents?label=%40oked%2Fopenai-agents" alt="@oked/openai-agents on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/openclaw"><img src="https://img.shields.io/npm/v/@oked/openclaw?label=%40oked%2Fopenclaw" alt="@oked/openclaw on npm"></a>
  <a href="https://www.npmjs.com/package/@oked/langgraph"><img src="https://img.shields.io/npm/v/@oked/langgraph?label=%40oked%2Flanggraph" alt="@oked/langgraph on npm"></a>
  <a href="https://github.com/oked-ai/oked-sdk/actions/workflows/ci.yml"><img src="https://github.com/oked-ai/oked-sdk/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@oked/sdk" alt="Apache-2.0 license"></a>
</p>

---

## What it does

OKed is an approval layer for AI coding agents ([oked.ai](https://oked.ai)). Before a risky tool call runs, OKed shows it to a person. Approve, and the action continues. Deny, or let the 10 minute window expire, and the action does not run.

Decisions are made in **Telegram** and on the **[web dashboard](https://oked.ai/dashboard)**. You can use either or both. Web push is an optional notification for the dashboard. The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

Classification looks at the kind of effect, not the command name, and it runs on your machine. Reads and other actions with no detected side effect are `safe` and run with no notification. Reversible local changes are `warning`: they run, and the terminal logs them. Destructive, irreversible, or outward-facing actions are `review` or `high_stakes` and wait for a person.

The Claude Code integration is a `PreToolUse` hook (`oked-hook`) in its own process. Changing Claude's permission mode does not remove that hook. The gate inside that process is [`@oked/hook-core`](./packages/hook-core). Claude Code's allow, deny, and unpaired `ask` behavior is unchanged. `@oked/sdk` and the other libraries run inside the process that calls them.

## Quick start

[Sign up](https://oked.ai/signup), then link Telegram or open the [dashboard](https://oked.ai/dashboard). That is where approvals show up.

| Agent | Install |
|---|---|
| **Claude Code** | `npm install -g @oked/claude-code`, then `oked init` |
| **Codex CLI** | `npm install -g @oked/codex`, then `oked-codex init`. In Codex, run `/hooks` and trust the hook. See the [package README](./packages/codex). |
| **Cursor** | `npm install -g @oked/cursor`, then `oked-cursor init`. See the [package README](./packages/cursor). |
| **GitHub Copilot** | `npm install -g @oked/copilot`, then `oked-copilot init`. CLI and VS Code. See the [package README](./packages/copilot). |
| **Claude Agent SDK** | `npm install @oked/claude-agent-sdk`, then pass `okedHooks()` in `options.hooks`. See the [package README](./packages/claude-agent-sdk). |
| **Vercel AI SDK** | `npm install @oked/ai-sdk`, then pass `okedToolApproval()` as `toolApproval`. See the [package README](./packages/ai-sdk). |
| **OpenAI Agents SDK** | `npm install @oked/openai-agents`, then wrap tools with `okedTool()` or `withOkedTools()`. See the [package README](./packages/openai-agents). |
| **OpenClaw** | `npm install -g @oked/openclaw @oked/openclaw-cli`, then `oked-openclaw init`. See the [package README](./packages/openclaw). |
| **LangGraph / LangChain (JavaScript)** | `npm install @oked/langgraph`, then pass `withOkedApprovals(tools)` to `ToolNode` or `createReactAgent`. See the [package README](./packages/langgraph). |
| **LangGraph / LangChain (Python)** | Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked" "oked-langgraph @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked-langgraph"`. Once it is on PyPI, `pip install oked-langgraph`. Then pass `with_oked_approvals(tools)` to `ToolNode` or `create_react_agent`. See [python/oked-langgraph](./python/oked-langgraph). |
| **Any Python agent** | Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked"`. Once it is on PyPI, `pip install oked`. Then call `OkedClient().approve(...)`. See [python/oked](./python/oked). |
| **NVIDIA OpenShell** | Separate repo: [oked-openshell](https://github.com/oked-ai/oked-openshell). `oked init --key-only` creates a key without installing the Claude Code hook. |
| **Any Node.js agent** | `npm install @oked/sdk` |

`oked init` writes a `PreToolUse` hook into the current project's `.claude/settings.json`, pairs this machine in the browser, and stores the API key in `~/.oked/config.json`. Open a new Claude Code session in that project. On a TTY, unless `NO_COLOR` is set, init also prints a QR code of the pairing link. A phone camera opens that link in the browser.

On Claude Code, test runners and scripts (`cargo test`, `npm test`, `npm run`, `pytest`, `go test`, `make`, `./script.sh`, `npx`) ask for approval unless the Bash sandbox is containing child processes. The hook cannot see commands those runners start. To allow them with no prompt, set `sandbox.enabled` to true and `allowUnsandboxedCommands` to false in `~/.claude/settings.json` or `.claude/settings.local.json`. `oked init` prints this when it is not already set. Other hosts do not read those files, so the same commands stay allowed there.

From Node.js, call `approve` before the action. A timeout is a denial. The client waits 630 seconds (`DEFAULT_APPROVAL_TIMEOUT_MS`) so the backend's 10 minute timeout is the one that comes back.

```ts
import { OKedClient } from "@oked/sdk";

const oked = new OKedClient(); // reads OKED_API_KEY, or ~/.oked/config.json

const { approved, decision } = await oked.approve({
  action: "create_payment",
  description: "Transfer 2,400 EUR to vendor@example.com",
  tier: "high_stakes",
});

if (!approved) throw new Error(`Blocked by OKed: ${decision}`);

await createPayment(amount, recipient);
```

`approve` resolves with `{ approved, approval_id, decision, receipt }`. `decision` is `"approved"`, `"denied"`, or `"timeout"`. `receipt` is the signed receipt when the backend sent one, already checked against the action you sent.

### When something fails

An explicit denial is final. An invalid API key, a receipt that does not verify, and an unexpected error deny the action. If nobody answers within 10 minutes, the decision is `timeout`, which denies.

If the backend is unreachable, OKed denies `high_stakes` and, by default, allows lower tiers. Set `OKED_STRICT_FAIL_CLOSED=1` (or `strictFailClosed: true`) to deny every sensitive action during an outage. HTTP 429 (too many approvals already waiting) is not an outage: the action is denied until those are decided in Telegram or on the dashboard.

On Claude Code, a device that is not paired returns `ask`, so Claude's own permission prompt can decide. Codex, Cursor, and Copilot deny that case (`Pair first: run` the host's init command). Codex treats `ask` as a failed hook and still runs the tool. Cursor accepts `ask` on `preToolUse` and does not enforce it. Copilot cloud agent and CLI autopilot turn `ask` into deny. The OpenClaw plugin denies sensitive calls when no API key is set. A LangGraph tool wrapped with `@oked/langgraph` denies the same way: with no API key the tool does not run, and the model receives the reason. The Vercel AI SDK package does the same: no API key denies a sensitive tool, and a denial or a timeout is returned to the model. The OpenAI Agents SDK package denies sensitive calls when no API key is set and returns that text as the tool result.

### Rules

A rule can always allow, always deny, or change the tier. Rules match kind, title, target, body, and the working directory, and the first match wins. On Telegram, use Rule on the card. On the dashboard, use the gear on a card, or open Rules. A rule's decision gets a receipt marked as a rule. See [Rules](https://oked.ai/docs#rules).

## Packages

All `@oked/*` packages share one version and are published together. Node.js 18 or newer.

| Package | Purpose |
|---|---|
| [`@oked/sdk`](./packages/sdk) | `OKedClient.approve()`, the tier classifier, and action descriptions. Call it from any Node.js agent. |
| [`@oked/hook-core`](./packages/hook-core) | Shared approval gate: classify, wait, check the receipt, fail closed. `npm install @oked/hook-core`. No init command. Host packages call `decide()`. |
| [`@oked/claude-code`](./packages/claude-code) | Claude Code hook. `oked init` writes `oked-hook` into `.claude/settings.json`. |
| [`@oked/codex`](./packages/codex) | Codex CLI `PreToolUse` hook. Writes `.codex/hooks.json`. `oked-codex init`, then `/hooks` to trust it. |
| [`@oked/cursor`](./packages/cursor) | Cursor `preToolUse` hook. Writes `.cursor/hooks.json` with timeout 690 and `failClosed`. `oked-cursor init`. |
| [`@oked/copilot`](./packages/copilot) | Copilot CLI and VS Code `preToolUse` hook. Writes `.github/hooks/oked.json` with `timeoutSec` 690. `oked-copilot init`. |
| [`@oked/claude-agent-sdk`](./packages/claude-agent-sdk) | `PreToolUse` hook for the Claude Agent SDK. Pass it in `options.hooks`. |
| [`@oked/ai-sdk`](./packages/ai-sdk) | Vercel AI SDK. `okedToolApproval()` for `generateText`, `streamText`, and `ToolLoopAgent`. `withOked()` and `okedTools()` wrap `execute`. |
| [`@oked/openai-agents`](./packages/openai-agents) | OpenAI Agents SDK tools. `okedTool()` or `withOkedTools()` asks before a risky tool runs. |
| [`@oked/openclaw`](./packages/openclaw) | OpenClaw plugin. `before_tool_call` classifies every tool the host reports. |
| [`@oked/openclaw-cli`](./packages/openclaw-cli) | `oked-openclaw`: installs the plugin and writes `~/.openclaw/openclaw.json`. |
| [`@oked/langgraph`](./packages/langgraph) | Wraps LangChain tools so a risky call waits on `approve()` before `ToolNode` or `createReactAgent` runs it. |
| [`oked`](./python/oked) | Python client. Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked"`. Once it is on PyPI, `pip install oked`. Then `OkedClient().approve()`. Python 3.9 or newer. |
| [`oked-langgraph`](./python/oked-langgraph) | Python LangGraph and LangChain. Not on PyPI yet. Until then, `pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked" "oked-langgraph @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked-langgraph"`. Once it is on PyPI, `pip install oked-langgraph`. Then `with_oked_approvals(tools)` for `ToolNode` or `create_react_agent`. Python 3.10 or newer. |
| [`@oked/receipt-core`](./packages/receipt-core) | Receipt format: canonical JSON, digests, Ed25519 signing and verification, chain checks. |
| [`@oked/verify`](./packages/verify) | `npx @oked/verify <export.zip>`: check an export offline. |

## Receipts

Every decision produces an Ed25519-signed receipt: who decided, how they were verified, the exact action, and when. Receipts are hash-chained, so a deleted or edited receipt is detectable.

The SDK checks the receipt before an integration acts on an approval. Since 0.6.0, an approval with no valid receipt is denied. Set `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts.

Check a receipt in the browser at [oked.ai/docs/#verify](https://oked.ai/docs#verify). Nothing is uploaded. Check an export offline:

```bash
npx @oked/verify oked-receipts.zip
```

Claude Code also keeps a local copy. `oked receipts verify` checks `~/.oked/receipts.jsonl`.

The field-by-field format is in [docs/receipts.md](./docs/receipts.md). Public keys are at `https://api.oked.ai/.well-known/oked-receipt-keys.json`.

## Develop

```bash
npm install
npm run build
npm test
```

CI runs that build and test on Node.js 18 and 22, and runs the Python tests (`.github/workflows/ci.yml`). Python packages live under `python/` and are not part of the npm workspace.

Releases are cut by pushing a `vX.Y.Z` tag. The publish workflow checks the tag against `package.json`, then publishes every package to npm with OIDC trusted publishing. Stable versions use the `latest` dist-tag. Prerelease versions (`vX.Y.Z-beta.1`) use `next`. The checklist is [RELEASING.md](./RELEASING.md).

```bash
npm run bump -- patch
npm install
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

## Links

- Product and docs: [oked.ai](https://oked.ai), [oked.ai/docs](https://oked.ai/docs)
- Sign up: [oked.ai/signup](https://oked.ai/signup)
- Dashboard: [oked.ai/dashboard](https://oked.ai/dashboard)
- Security: [oked.ai/security](https://oked.ai/security) and [SECURITY.md](./SECURITY.md)
- Contact: [contact@oked.ai](mailto:contact@oked.ai)
- Issues: [github.com/oked-ai/oked-sdk/issues](https://github.com/oked-ai/oked-sdk/issues)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- Hosts: [docs/hosts.md](./docs/hosts.md)

## License

[Apache-2.0](./LICENSE)
