/**
 * @oked/langgraph. Gate LangChain tools with OKed before they run.
 *
 * `withOkedApproval` / `withOkedApprovals` return the same tools, with
 * `invoke` (and `call`, `func`, and `batch`) waiting on `approve()` when the
 * call is `review` or `high_stakes`. Pass the result to `ToolNode` or
 * `createReactAgent`. A denial or a timeout does not call the tool. The model
 * gets an error `ToolMessage` (or a string, when you invoked the tool with
 * raw arguments) that says the action was not run.
 *
 * This does not call LangGraph `interrupt()`. That pause is for the process
 * that resumes the graph. The person who decides here is on Telegram or the
 * web dashboard, and `approve()` already waits for them.
 */
import { ToolMessage } from "@langchain/core/messages";
import {
  createOkedClient,
  gateToolCall,
  toolInputRecord,
  type OkedGateResult,
  type OkedLangGraphOptions,
  type OkedToolLike,
} from "./gate.js";

const WRAPPED = Symbol.for("oked.langgraph.wrapped");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCall(input: unknown): input is { id?: string; name: string; args: unknown; type: "tool_call" } {
  return isRecord(input) && input.type === "tool_call" && typeof input.name === "string" && "args" in input;
}

/**
 * A result the model can read. ToolNode passes a real ToolMessage through.
 * A thrown error would be rewritten as "Please fix your mistakes", which
 * sounds transient, so a denial is a normal return with status "error".
 * A string return would be marked success. Raw `invoke` (no tool call id)
 * gets the same text as a string.
 */
function denialResult(toolName: string, input: unknown, message: string): unknown {
  if (!isToolCall(input)) return message;
  const id = typeof input.id === "string" ? input.id : "";
  return new ToolMessage({
    content: message,
    name: toolName,
    tool_call_id: id,
    status: "error",
  });
}

function configFromFuncArgs(args: unknown[]): unknown {
  const third = args[2];
  if (isRecord(third)) return third;
  const second = args[1];
  if (isRecord(second) && "configurable" in second) return second;
  return undefined;
}

interface RunGate {
  (input: unknown, config: unknown): Promise<unknown>;
}

function makeRunner(tool: OkedToolLike, options: OkedLangGraphOptions): RunGate {
  const invoke = tool.invoke;
  return async (input, config) => {
    const gate: OkedGateResult = await gateToolCall(tool.name, toolInputRecord(input), {
      ...options,
      config,
    });
    if (!gate.run) {
      return denialResult(tool.name, input, gate.message ?? "OKed: this action was not run.");
    }
    return Reflect.apply(invoke, tool, [input, config]);
  };
}

/**
 * Wrap one LangChain tool. `name`, `description`, and `schema` are unchanged,
 * so `bindTools` still sees the original tool. The body runs only after an
 * approval when the tier requires one.
 */
export function withOkedApproval<T extends OkedToolLike>(tool: T, options?: OkedLangGraphOptions): T {
  if (tool === null || typeof tool !== "object") {
    throw new TypeError("OKed: withOkedApproval expected a LangChain tool");
  }
  if ((tool as { [WRAPPED]?: boolean })[WRAPPED] === true) return tool;
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new TypeError("OKed: withOkedApproval expected a tool with a name");
  }
  if (typeof tool.invoke !== "function") {
    throw new TypeError(`OKed: tool "${tool.name}" has no invoke function`);
  }

  const opts: OkedLangGraphOptions = options?.client ? options : { ...options, client: createOkedClient(options) };
  const run = makeRunner(tool, opts);

  return new Proxy(tool, {
    get(target, prop, _receiver) {
      if (prop === WRAPPED) return true;
      if (prop === "invoke") {
        return (input: unknown, config?: unknown) => run(input, config);
      }
      if (prop === "call") {
        const call = Reflect.get(target, "call", target);
        if (typeof call !== "function") return undefined;
        return async (...args: unknown[]) => {
          const gate = await gateToolCall(target.name, toolInputRecord(args[0]), {
            ...opts,
            config: args[1],
          });
          if (!gate.run) return denialResult(target.name, args[0], gate.message ?? "OKed: this action was not run.");
          return Reflect.apply(call, target, args);
        };
      }
      if (prop === "func") {
        const func = Reflect.get(target, "func", target);
        if (typeof func !== "function") return func;
        return async (...args: unknown[]) => {
          const gate = await gateToolCall(target.name, toolInputRecord(args[0]), {
            ...opts,
            config: configFromFuncArgs(args),
          });
          if (!gate.run) return gate.message ?? "OKed: this action was not run.";
          return Reflect.apply(func, target, args);
        };
      }
      if (prop === "batch") {
        const batch = Reflect.get(target, "batch", target);
        if (typeof batch !== "function") return batch;
        return (inputs: unknown, ...rest: unknown[]) => {
          if (!Array.isArray(inputs)) return Reflect.apply(batch, target, [inputs, ...rest]);
          const config = rest[0];
          return Promise.all(inputs.map((input: unknown) => run(input, config)));
        };
      }
      // Bind to the original tool, not the proxy, so methods that use
      // private fields keep working. invoke/call/func/batch are the
      // execution paths and are gated above.
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as T;
}

/**
 * Wrap each tool with one shared client. Pass the array to `new ToolNode(tools)`
 * or `createReactAgent({ llm, tools })`. An already wrapped tool is left as it is.
 */
export function withOkedApprovals<T extends OkedToolLike>(
  tools: readonly T[],
  options?: OkedLangGraphOptions,
): T[] {
  if (!Array.isArray(tools)) {
    throw new TypeError("OKed: withOkedApprovals expected an array of tools");
  }
  const shared: OkedLangGraphOptions = options?.client
    ? options
    : { ...options, client: createOkedClient(options) };
  return tools.map((tool) => withOkedApproval(tool, shared));
}

export { createOkedClient, gateToolCall };
export type {
  OkedApprovalClient,
  OkedGateResult,
  OkedLangGraphOptions,
  OkedToolLike,
} from "./gate.js";
