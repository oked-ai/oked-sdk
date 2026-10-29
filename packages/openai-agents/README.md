# @oked/openai-agents

[![npm version](https://img.shields.io/npm/v/@oked/openai-agents.svg)](https://www.npmjs.com/package/@oked/openai-agents)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/openai-agents.svg)](./LICENSE)

OKed for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (`@openai/agents`). Risky tool calls wait for a person, in Telegram or on the [web dashboard](https://oked.ai/dashboard), before they run. The iPhone app is coming soon.

Calling `approve()` yourself inside every tool still works. This package is the version you do not have to repeat.

## Install

```sh
npm install @oked/openai-agents
```

`@openai/agents` is a peer dependency (`>=0.21.0`). You already have it if you are building an agent. Node.js 18 or newer. The Agents SDK imports `@modelcontextprotocol/client`, which asks for Node.js 20, so this package depends on that client directly and the import still resolves on Node.js 18. The first npm publish of this package is done by hand; after that it ships with the other `@oked/*` packages. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## One tool

`okedTool()` takes the same arguments as `tool()`. Sensitive calls wait. A denial, a timeout, or an error is the tool result the model sees, and your `execute` function is not called.

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { okedTool } from "@oked/openai-agents";

const refundPayment = okedTool({
  name: "refund_payment",
  description: "Refund a charge",
  parameters: z.object({ chargeId: z.string(), amount: z.number() }),
  async execute({ chargeId, amount }) {
    return `Refunded ${amount} on ${chargeId}`;
  },
});

const agent = new Agent({
  name: "Billing",
  instructions: "Refund a charge only when the tool result says the refund ran.",
  tools: [refundPayment],
});

const result = await run(agent, "Refund charge ch_123 for 20 dollars.");
console.log(result.finalOutput);
```

Do not also set `needsApproval` on that tool. For function tools the Agents SDK has no in-process approval callback: `needsApproval` pauses the run until your code calls `state.approve()` or `state.reject()`. `okedTool()` is that approval. A second pause would ask twice, and only after you resumed the run.

## A tool list

`withOkedTools()` wraps an array you already built.

```ts
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { withOkedTools } from "@oked/openai-agents";

const getOrder = tool({
  name: "get_order",
  description: "Look up an order",
  parameters: z.object({ orderId: z.string() }),
  async execute({ orderId }) {
    return `Order ${orderId} is paid`;
  },
});

const refundPayment = tool({
  name: "refund_payment",
  description: "Refund a charge",
  parameters: z.object({ chargeId: z.string(), amount: z.number() }),
  async execute({ chargeId, amount }) {
    return `Refunded ${amount} on ${chargeId}`;
  },
});

const agent = new Agent({
  name: "Billing",
  instructions: "Look up orders. Refund only when the tool result says the refund ran.",
  // get_order is not a known read-only name, so it would otherwise be review.
  tools: withOkedTools([getOrder, refundPayment], {
    alwaysAllow: ["get_order"],
  }),
});
```

Wrapping a tool that is already wrapped is a no-op, so passing an `okedTool()` through `withOkedTools()` does not ask twice.

What each tool type does:

| Tool | What the wrapper does |
|---|---|
| Function tool | Gates `invoke` before your code runs. The model gets the decision as the tool result. |
| Local shell, `apply_patch` | Sets `needsApproval` and `onApproval`. The SDK resolves the call in-process. A rejection reason is the text the model sees. |
| Hosted MCP | Sets `require_approval` to `always` and `on_approval` to the same decision. The original tool object is not modified. |
| Hosted shell, computer, other hosted tools | Left unchanged. This process does not run them. Put `needsApproval` on them and use `settleOkedInterruptions()`, or keep the risky work in a function tool. |

Hosted shell prints a warning when it is left unchanged.

## Tools that already pause

If you already use `needsApproval` and you are not wrapping the tool, resolve the pause with OKed and resume:

```ts
import { run } from "@openai/agents";
import { settleOkedInterruptions } from "@oked/openai-agents";

let result = await run(agent, "Cancel order 17.");
while (result.interruptions?.length) {
  await settleOkedInterruptions(result);
  result = await run(agent, result.state);
}
```

An approval calls `state.approve`. A denial, a timeout, or an error calls `state.reject` with a message. Nothing is left pending.

## Auth

Provide a key in either place:

- `OKED_API_KEY` in the environment, or
- `~/.oked/config.json` (`{ "apiKey": "ok_..." }`)

Create a key from the [dashboard](https://oked.ai/dashboard) after you [sign up](https://oked.ai/signup). There is no pairing command in this package.

Each request sends `source: "openai-agents"` and `client: "@oked/openai-agents@<version>"`. Both are part of the receipt subject. An approval counts only when the signed receipt verifies.

## Configuration

Pass a second argument to `okedTool()`, `withOkedTools()`, or `settleOkedInterruptions()`.

| Option | Default | Description |
|---|---|---|
| `apiKey` | `OKED_API_KEY`, then `~/.oked/config.json` | OKed API key. With no key, a sensitive call is denied. |
| `timeoutMs` | `630000` | How long to wait for a person, in milliseconds (10.5 minutes, so the backend's 10 minute expiry answers first). |
| `strictFailClosed` | `false` | When true, an unreachable approval service denies every sensitive call. Env `OKED_STRICT_FAIL_CLOSED`. |
| `minTier` | `"review"` | Lowest tier that asks. `warning` never blocks on its own. Env `OKED_MIN_TIER` is the fallback. |
| `alwaysApprove` | `[]` | Tool names that are always `high_stakes`. |
| `alwaysAllow` | `[]` | Tool names that are always safe. Skips rules and approval. |
| `cwd` | `process.cwd()` | Recorded on the approval. |
| `sessionId` | `context.sessionId` or `context.session_id` | String, or a function of the run context. |
| `deniedOutput` | none | Value returned when the tool has an output schema. It must match that schema. |

Unknown tool names are `review` (a person is required at the default `minTier`). Names the shared classifier already treats as read-only, such as `read_file`, stay safe. A `command` or `cmd` string is classified as a shell command, so `rm -rf` and `git push --force` are `high_stakes` even under a custom tool name.

If you set `timeoutMs` on the function tool itself, it is raised to at least the approval wait plus 60 seconds (690 seconds with the default wait). A shorter cap would abort the wait and hand the model a generic tool timeout.

`approve` replaces the client call. It is for tests. Leave it unset in production.

## Behavior

| Tier | What happens |
|---|---|
| `safe` | Run immediately, no approval request |
| `warning` | Run, log to stderr, no approval request |
| `review` / `high_stakes` | Ask. Approve and the tool runs. Otherwise the model is told the tool did not run, and told not to retry it. |

A cached user rule that matches a safe or warning call sends that call to the approval service, which applies the rule. `alwaysAllow` does not consult rules.

Failure handling: no API key denies. An invalid key denies. A receipt that does not verify denies. HTTP 429 (too many approvals already waiting) denies until those are decided in Telegram or on the dashboard. An unreachable approval service denies `high_stakes` and, by default, allows lower tiers. Any other unexpected error denies. None of these run the tool.

## Output schemas

A tool with `outputSchema` cannot return a free-form sentence. Pass `deniedOutput` that matches the schema so the model still sees a result:

```ts
const refundPayment = okedTool(
  {
    name: "refund_payment",
    description: "Refund a charge",
    parameters: z.object({ chargeId: z.string(), amount: z.number() }),
    outputSchema: z.object({ ok: z.boolean(), detail: z.string() }),
    async execute({ chargeId, amount }) {
      return { ok: true, detail: `Refunded ${amount} on ${chargeId}` };
    },
  },
  {
    deniedOutput: (denial) => ({ ok: false, detail: denial.message }),
  },
);
```

Without `deniedOutput`, the wrapper throws `OkedToolDeniedError` and the tool does not run.

## License

[Apache-2.0](./LICENSE)
