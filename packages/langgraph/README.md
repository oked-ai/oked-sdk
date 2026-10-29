# @oked/langgraph

[![npm version](https://img.shields.io/npm/v/@oked/langgraph.svg)](https://www.npmjs.com/package/@oked/langgraph)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/langgraph.svg)](./LICENSE)

OKed for [LangGraph.js](https://github.com/langchain-ai/langgraphjs) and LangChain tools. Wrap a tool, and a risky call waits for a person in Telegram or on the [web dashboard](https://oked.ai/dashboard) before it runs. The iPhone app is coming soon.

`withOkedApproval` wraps one tool. `withOkedApprovals` wraps a list. Pass that list to `ToolNode` or `createReactAgent`. Denied, timed out, and failed approvals do not run the tool. The model gets a result that says the action was not run.

Python agents use [`oked-langgraph`](../../python/oked-langgraph) (`pip install oked-langgraph`). `with_oked_approvals` is the same gate for `ToolNode` and `create_react_agent`. The receipt `source` is `langgraph` in both packages.

## Install

```sh
npm install @oked/langgraph
```

`@langchain/core` is a peer dependency (`>=0.2.31`). `@langchain/langgraph` is an optional peer (`>=0.2.0`): install it if you use `ToolNode` or `createReactAgent`. You already have both if you are building a LangGraph agent. Node.js 18 or newer.

Set a key before the process starts:

```sh
export OKED_API_KEY=ok_...
```

Create a key from the [dashboard](https://oked.ai/dashboard) after you [sign up](https://oked.ai/signup). You can also run `oked init --key-only` from [`@oked/claude-code`](../claude-code). A key in `~/.oked/config.json` (`{ "apiKey": "ok_..." }`) works when the environment variable is unset.

## Quick start

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { withOkedApprovals } from "@oked/langgraph";

const agent = createReactAgent({
  llm,
  tools: withOkedApprovals([searchDocs, sendEmail, refundOrder]),
});
```

One tool:

```ts
import { withOkedApproval } from "@oked/langgraph";

const sendEmail = withOkedApproval(rawSendEmail, { tier: "high_stakes" });
```

A tool node:

```ts
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { withOkedApprovals } from "@oked/langgraph";

const toolNode = new ToolNode(
  withOkedApprovals([searchDocs, sendEmail], {
    alwaysApprove: ["sendEmail"],
    alwaysAllow: ["searchDocs"],
  }),
);
```

`name`, `description`, and `schema` are unchanged, so the same objects can go to `bindTools`. `createAgent` from the `langchain` package takes the wrapped list the same way.

The wrapper gates `invoke`, `call`, `func`, and `batch`. `ToolNode` and `createReactAgent` call `invoke`. On an approval, that call is forwarded with the same arguments and the same config, including `configurable.thread_id` (recorded as the approval session).

## Why this is not interrupt()

LangGraph's `interrupt()`, and `interruptBefore` / `interruptAfter` on `createReactAgent`, pause the graph until the code that invoked the graph resumes it with `Command({ resume })`. That person is whoever is driving the process. They need a checkpointer, and a resume that forgets to check the decision runs the tool.

OKed's person is on Telegram or the web dashboard. `approve()` already waits for them (10 minutes on the server, 630 seconds in the client). Doing that wait inside the tool, before the tool body, means:

- `ToolNode` and `createReactAgent` do not need a checkpointer or a resume step.
- A denial cannot be skipped by resuming the graph.
- One denied call does not cancel a sibling tool call in the same turn. Each tool waits on its own.
- The model receives a tool result either way, so the turn can continue.

The process has to stay up for the wait. If it is killed first, the tool does not run. There is no checkpoint to resume, because the approval is not a graph interrupt. Allow at least 630 seconds for a gated call. `timeoutMs` changes the client wait. A timeout is a denial.

`gateToolCall` is the same decision without wrapping, for a node you wrote yourself. Run the tool only when `run` is true. Otherwise return `message` to the model and do not call the tool.

```ts
import { ToolMessage } from "@langchain/core/messages";
import { gateToolCall } from "@oked/langgraph";

const gate = await gateToolCall(call.name, call.args, { config });
if (!gate.run) {
  return new ToolMessage({
    content: gate.message,
    tool_call_id: call.id,
    status: "error",
  });
}
```

## Auth and receipts

Each request sends `source: "langgraph"` and `client: "@oked/langgraph@<version>"`. Both are part of the receipt subject. An approval counts only when the signed receipt verifies. A missing or invalid receipt denies the tool.

`OKED_REQUIRE_RECEIPT=0` is only for a backend that does not sign receipts.

## Behavior

Same tiers as the other integrations. Unknown tool names are `review` (approval required) unless you set `tier`, `alwaysAllow`, or `minTier`.

| Tier | What happens |
|---|---|
| `safe` | Run immediately. No approval request, unless a cached user rule matches. |
| `warning` | Run, and log a line to stderr. No approval request, unless a cached user rule matches. |
| `review` / `high_stakes` | Wait for a person. Approve, and the tool runs with the original arguments. Otherwise it does not run, and the model is told not to retry. |

A tool with a string `command` or `cmd` is classified as a shell command. A tool with a path and a content string is classified as a file write.

Failure handling, when the tool would have needed a person:

| What happened | Result |
|---|---|
| Person denies | Tool does not run. |
| Approval window expires (`timeout`) | Tool does not run. A client-side abort is the same denial, not an outage. |
| No API key | Tool does not run. LangGraph has no separate permission prompt to defer to. |
| Invalid API key, bad receipt, HTTP 429, other HTTP error, unexpected error | Tool does not run. |
| Backend unreachable, tier `high_stakes` | Tool does not run. |
| Backend unreachable, lower tier | Tool runs, and a warning is logged, unless `OKED_STRICT_FAIL_CLOSED=1` (or `strictFailClosed: true`), which denies every sensitive call during an outage. |

The text returned to the model always says the action was not run and not to retry the same call. `ToolNode` receives that as a `ToolMessage` with `status: "error"`. Throwing would let `ToolNode` replace the reason with "Please fix your mistakes", which reads as a transient error.

A cached user rule can send a `safe` or `warning` call to the backend, which applies the rule and signs the receipt. Edit rules in Telegram (Rule on the card) or on the dashboard (the gear on a card, or Rules).

## Options

| Option | Role |
|---|---|
| `apiKey` | Overrides `OKED_API_KEY` and `~/.oked/config.json`. |
| `timeoutMs` | Client wait, in milliseconds. Default 630000. |
| `strictFailClosed` | Deny every sensitive call when the backend is unreachable. |
| `minTier` | Lowest tier that waits. Default `review`. `OKED_MIN_TIER` is the fallback. `warning` never waits on tier alone. |
| `alwaysApprove` | Exact tool names that always wait, at `high_stakes`. |
| `alwaysAllow` | Exact tool names that never wait. The tool runs. |
| `tier` | Use this tier instead of the classifier. `alwaysAllow` and `alwaysApprove` still win. |
| `sessionId` | Stored on the approval. Wins over `config.configurable.thread_id`. |
| `cwd` | Stored on the approval. Default `process.cwd()`. |

`createOkedClient(options)` builds the client the wrappers use (`source: "langgraph"`). Pass it as `client` if several custom `gateToolCall`s should share one. Tests pass a fake `client` with `approve`, `getRules`, `heartbeat`, `apiKey`, and `strictFailClosed`.

## License

[Apache-2.0](./LICENSE). Questions: [contact@oked.ai](mailto:contact@oked.ai).
