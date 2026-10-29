# @oked/ai-sdk

[![npm version](https://img.shields.io/npm/v/@oked/ai-sdk.svg)](https://www.npmjs.com/package/@oked/ai-sdk)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/ai-sdk.svg)](./LICENSE)

OKed for the [Vercel AI SDK](https://ai-sdk.dev) (`ai`). Risky tool calls wait for a person, in Telegram or on the [web dashboard](https://oked.ai/dashboard), before `execute` runs. The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

AI SDK 7 decides this on the call, through `toolApproval`. `okedToolApproval()` waits on `approve()` from [`@oked/sdk`](../sdk) and answers in that same call. A denial or a timeout comes back as `{ type: "denied", reason }`. The AI SDK does not run the tool, and the reason is the `execution-denied` result the model reads.

This package does not return `user-approval`. That status ends the generation and leaves the tool runnable until some later request answers it. Forgetting that second step, or answering it in code, would run the tool with no OKed decision.

`withOked()` and `okedTools()` wrap `execute` instead. Use them when the gate has to live on the tool object, or on AI SDK 5 and 6 (those versions have `needsApproval`, which is the same two-step pause). Do not set `toolApproval` on a tool you already wrapped. The person would be asked twice.

## Install

```sh
npm install @oked/ai-sdk
```

`ai` is an optional peer dependency (`>=5.0.0`). You already have it if you are calling `generateText`, `streamText`, or `ToolLoopAgent`. `okedToolApproval()` needs AI SDK 7. The `execute` wrappers also work on AI SDK 5 and 6. Node.js 18 or newer.

This package has no pairing command. Provide a key in either place:

- `OKED_API_KEY` in the environment, or
- `~/.oked/config.json` (`{ "apiKey": "ok_..." }`)

Create a key from the [dashboard](https://oked.ai/dashboard) after you [sign up](https://oked.ai/signup), or run `oked init --key-only` from [`@oked/claude-code`](../claude-code).

Each request sends `source: "ai-sdk"` and `client: "@oked/ai-sdk@<version>"`. Both are part of the receipt subject.

## Quick start

Pass `okedToolApproval()` as `toolApproval`. Every tool on that call is classified. `safe` and `warning` run immediately. `review` and `high_stakes` wait. The default wait is 630 seconds, so the backend's 10 minute window is the one that answers. A timeout denies.

```ts
import { generateText, isStepCount, tool } from "ai";
import { okedToolApproval } from "@oked/ai-sdk";
import { z } from "zod";

const runCommand = tool({
  description: "Run a shell command",
  inputSchema: z.object({
    command: z.string(),
  }),
  execute: async ({ command }) => {
    // Runs only after OKed has approved a sensitive command.
    return { command, exitCode: 0 };
  },
});

const result = await generateText({
  model, // your AI SDK model
  tools: { runCommand },
  toolApproval: okedToolApproval(),
  stopWhen: isStepCount(5),
  instructions: "When OKed denies a tool, do not retry that action. Ask the user how to proceed.",
  prompt: "Delete the old export in /var/data",
});
```

`streamText` takes the same `toolApproval` option. The stream stays open while a person decides, then continues.

## Agent

```ts
import { ToolLoopAgent, isStepCount } from "ai";
import { okedToolApproval } from "@oked/ai-sdk";

const agent = new ToolLoopAgent({
  model,
  instructions: "When OKed denies a tool, do not retry that action. Ask the user how to proceed.",
  tools: { runCommand },
  toolApproval: okedToolApproval(),
  stopWhen: isStepCount(10),
});

const result = await agent.generate({
  prompt: "Remove /var/data/old-export",
});
```

`agent.stream()` uses the same constructor option.

## One tool, or a tools object

`okedToolApprovalFor(name)` is the per-tool form. A tool you leave off the map is not gated, so prefer the function above unless you mean to opt out.

```ts
toolApproval: {
  runCommand: okedToolApprovalFor("runCommand"),
  readFile: "not-applicable",
}
```

Wrap `execute` when you want the gate on the tool itself:

```ts
import { withOked, okedTools } from "@oked/ai-sdk";

const runCommand = withOked(
  tool({
    description: "Run a shell command",
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => ({ command, exitCode: 0 }),
  }),
  { name: "runCommand" },
);

const tools = okedTools({ runCommand, readFile });
```

`name` is the key you put on the tools object. `withOked` returns a new tool and does not change the original. On approve, `execute` is called with the same input and the same options object, including `toolCallId` and `abortSignal`. On deny, timeout, or error, `execute` is not called.

The wrapper returns this object, which the model sees as the tool result:

```ts
{
  oked: "denied",
  decision: "denied" | "timeout" | "error",
  approvalId: string | null,
  tier: "safe" | "warning" | "review" | "high_stakes",
  reason: string
}
```

`isOkedDenial(value)` checks that shape. If the tool defines `outputSchema`, the wrapper throws `OkedDeniedError` instead, with the same reason as `message`, so schema validation cannot replace the reason with a validation error.

A tool with no `execute` (a provider-executed tool, or a client-side tool) cannot be stopped from this package. `okedTools` copies it through and logs that it is not gated. `withOked` throws at setup time. The AI SDK's own `toolApproval` has the same limit: it only covers tools the SDK executes locally.

## Configuration

Same ideas as the other integrations. Omit these to use the defaults.

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `OKED_API_KEY`, then `~/.oked/config.json` | Used when you do not pass `client`. |
| `timeoutMs` | `630000` | How long to wait. A timeout denies. Used when you do not pass `client`. |
| `minTier` | `"review"` (`OKED_MIN_TIER`) | Lowest tier that waits. `high_stakes` asks only for that tier. |
| `alwaysApprove` | none | Tool names that always wait, including names the classifier calls safe. |
| `alwaysAllow` | none | Tool names that always run. Wins over `alwaysApprove`. Exact, case-sensitive. |
| `strictFailClosed` | `false` (`OKED_STRICT_FAIL_CLOSED=1`) | When true, an unreachable backend denies every sensitive tool. When false, it denies `high_stakes` only. |
| `cwd` | `process.cwd()` | Recorded on the approval. |
| `sessionId` | the AI SDK tool call id | Receipt session. Set it to group a whole conversation. |
| `client` | a new `OKedClient` | Pass an existing client, or a test double. |
| `log` | stderr, prefixed with `[OKed]` | Receives the message with no prefix. |

`safe` and `warning` do not wait, even if `minTier` is lower, unless `alwaysApprove` lists the tool or a saved rule matches. A matching rule sends the call to `approve()` so the rule is applied on the server and the receipt records it. If the rules lookup fails, `safe` and `warning` still run. `review` and `high_stakes` do not depend on that lookup.

```ts
toolApproval: okedToolApproval({
  minTier: "high_stakes",
  alwaysApprove: ["sendEmail"],
  alwaysAllow: ["readFile"],
  cwd: process.cwd(),
})
```

## Behavior

| Situation | What the model gets | Does `execute` run? |
|---|---|---|
| `safe`, or `warning` with no matching rule | nothing extra (`toolApproval` returns `undefined`) | yes |
| Person approves | the tool's own result. The transcript also records `{ type: "approved" }`. | yes |
| Person denies | `{ type: "denied", reason }` and an `execution-denied` tool result | no |
| Approval window expires (`timeout`) | the same denial shape. The reason says nobody responded. | no |
| No API key, invalid key, bad receipt, HTTP error, unexpected error | a denial that tells the model not to retry | no |
| Backend unreachable, `high_stakes` or `strictFailClosed` | a denial | no |
| Backend unreachable, lower sensitive tier, strict mode off | the tool runs. Stderr says it was allowed degraded. | yes |

An explicit denial is final. A timeout is a denial. Nothing in those paths fails open.

Add a line to your instructions: "When OKed denies a tool, do not retry that action." The reason already says not to retry. Models still retry a bare tool error more often than a sentence that tells them to stop.

## Timeouts

The client waits 630 seconds (`DEFAULT_APPROVAL_TIMEOUT_MS`). That is 30 seconds past the 10 minute window, so the backend's `timeout` answer is the one that comes back, and the tool is denied.

Set the server's max duration, and any AI SDK `timeout` or `timeout.stepMs`, above that wait. Those budgets include the tool step. A platform that kills the process during the wait cannot deliver the denial, because the process is gone. `timeoutMs` on this package shortens the OKed wait itself. That shorter wait still denies. It does not let the tool run.

## Receipts

`approve()` checks the signed receipt before an approval counts. A receipt that does not verify denies the tool. An approval with no receipt denies too, which is the default since 0.6.0. A deny or a timeout that arrives without a receipt stays a deny. See [docs/receipts.md](../../docs/receipts.md).

## License

[Apache-2.0](./LICENSE)
