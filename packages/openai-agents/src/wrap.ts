/**
 * Wire OKed into OpenAI Agents SDK tools.
 *
 * Function tools have no programmatic onApproval. needsApproval only pauses
 * the run until the app calls state.approve or state.reject. Gating execute
 * (and invoke) instead returns the decision to the model in the same turn
 * and does not run the tool on a denial, a timeout, or an error.
 *
 * Local shell, apply_patch, and hosted MCP already accept an onApproval
 * callback that resolves in-process. Those wrappers use that callback.
 * Hosted shell runs outside this process, so it is left unchanged.
 */
import { tool, type FunctionTool, type Tool } from "@openai/agents";
import { OkedToolDeniedError, type OkedDenial } from "./messages.js";
import {
  createDeps,
  decideToolCall,
  toolTimeoutFloor,
  type GateDeps,
  type OkedAgentsConfig,
} from "./gate.js";

const WRAPPED = Symbol.for("@oked/openai-agents.wrapped");

type AnyRecord = Record<string, unknown>;

interface FunctionLike {
  type: "function";
  name: string;
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  outputSchema?: unknown;
  timeoutMs?: number;
  needsApproval?: unknown;
}

interface ShellLike {
  type: "shell";
  name: string;
  shell?: unknown;
  environment?: { type?: string };
  needsApproval?: (runContext: unknown, action: unknown, callId?: string) => Promise<boolean> | boolean;
  onApproval?: (
    runContext: unknown,
    approvalItem: unknown,
  ) => Promise<{ approve: boolean; reason?: string }>;
}

interface PatchLike {
  type: "apply_patch";
  name: string;
  needsApproval?: (runContext: unknown, operation: unknown, callId?: string) => Promise<boolean> | boolean;
  onApproval?: (
    runContext: unknown,
    approvalItem: unknown,
  ) => Promise<{ approve: boolean; reason?: string }>;
}

interface HostedMcpLike {
  type: "hosted_tool";
  name: string;
  providerData?: AnyRecord;
}

type ApprovalState = {
  approve: (item: unknown, options?: { alwaysApprove?: boolean }) => void;
  reject: (item: unknown, options?: { alwaysReject?: boolean; message?: string }) => void;
};

export interface OkedRunLike {
  interruptions?: readonly unknown[];
  state: ApprovalState;
}

function isWrapped(value: object): boolean {
  return Boolean((value as Record<symbol, unknown>)[WRAPPED]);
}

function mark<T extends object>(value: T): T {
  (value as Record<symbol, unknown>)[WRAPPED] = true;
  return value;
}

function cloneWith<T extends object>(value: T, overrides: AnyRecord): T {
  const descriptors = Object.getOwnPropertyDescriptors(value) as PropertyDescriptorMap;
  for (const key of Reflect.ownKeys(overrides)) {
    delete descriptors[key];
  }
  const clone = Object.create(Object.getPrototypeOf(value), descriptors) as T;
  return Object.assign(clone, overrides);
}

function asRecord(value: unknown): AnyRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as AnyRecord;
  if (Array.isArray(value)) return { items: value };
  if (value === undefined || value === null) return {};
  return { input: value };
}

/** Parse model arguments into the object classify() and approve() expect. */
export function parseToolInput(value: unknown): AnyRecord {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return { input: value };
    }
  }
  return asRecord(value);
}

function asObj(value: unknown): AnyRecord {
  if (value && typeof value === "object") return value as AnyRecord;
  return {};
}

function shellActionArgs(action: unknown): AnyRecord {
  const record = asObj(action);
  if (Array.isArray(record.commands)) {
    const commands = record.commands.filter((item): item is string => typeof item === "string");
    return { command: commands.join(" && "), commands };
  }
  return asRecord(action);
}

function patchArgs(operation: unknown): AnyRecord {
  const op = asObj(operation);
  const path = typeof op.path === "string" ? op.path : undefined;
  if (op.type === "delete_file" && path) return { command: `rm -- ${path}`, path };
  const args: AnyRecord = {};
  if (typeof op.type === "string") args.operation = op.type;
  if (path) args.path = path;
  if (typeof op.diff === "string") args.diff = op.diff;
  return args;
}

export function argsFromApprovalItem(item: unknown): { name: string; args: AnyRecord } {
  const record = asObj(item);
  const raw = asObj(record.rawItem);
  const named =
    typeof record.name === "string" && record.name
      ? record.name
      : typeof raw.name === "string" && raw.name
        ? raw.name
        : "";
  if (raw.type === "shell_call") {
    return { name: named || "shell", args: shellActionArgs(raw.action) };
  }
  if (raw.type === "apply_patch_call") {
    return { name: named || "apply_patch", args: patchArgs(raw.operation) };
  }
  const source =
    typeof record.arguments === "string"
      ? record.arguments
      : typeof raw.arguments === "string"
        ? raw.arguments
        : (record.arguments ?? raw.arguments);
  return { name: named || "tool", args: parseToolInput(source) };
}

function blockResult(denial: OkedDenial, hasOutputSchema: boolean, config: OkedAgentsConfig): unknown {
  if (config.deniedOutput) return config.deniedOutput(denial);
  if (hasOutputSchema) throw new OkedToolDeniedError(denial);
  return denial.message;
}

function raisedTimeout(existing: number | undefined, config: OkedAgentsConfig): number | undefined {
  if (typeof existing !== "number") return undefined;
  return Math.max(existing, toolTimeoutFloor(config));
}

function isHostedShell(candidate: ShellLike): boolean {
  const kind = candidate.environment?.type;
  return kind === "container_auto" || kind === "container_reference";
}

async function onApprovalDecision(
  name: string,
  args: AnyRecord,
  config: OkedAgentsConfig,
  deps: GateDeps,
  runContext: unknown,
  previous:
    | ((runContext: unknown, approvalItem: unknown) => Promise<{ approve: boolean; reason?: string }>)
    | undefined,
  approvalItem: unknown,
): Promise<{ approve: boolean; reason?: string }> {
  const decision = await decideToolCall(name, args, config, deps, runContext);
  if (!decision.proceed) return { approve: false, reason: decision.denial.message };
  if (!previous) return { approve: true };
  try {
    const extra = await previous(runContext, approvalItem);
    if (!extra?.approve) {
      return {
        approve: false,
        reason:
          extra?.reason ||
          `OKed allowed ${name}, but the tool's own approval callback rejected it. The tool did not run.`,
      };
    }
    return { approve: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      approve: false,
      reason: `OKed: the tool's own approval callback for ${name} threw (${message}). The tool did not run.`,
    };
  }
}

function wrapFunctionTool<T extends FunctionLike>(toolDef: T, config: OkedAgentsConfig, deps: GateDeps): T {
  const originalInvoke = toolDef.invoke;
  const hasOutputSchema = toolDef.outputSchema !== undefined;
  const invoke = async (runContext: unknown, input: string, details?: unknown) => {
    const decision = await decideToolCall(toolDef.name, parseToolInput(input), config, deps, runContext);
    if (!decision.proceed) return blockResult(decision.denial, hasOutputSchema, config);
    return originalInvoke(runContext, input, details);
  };
  const timeoutMs = raisedTimeout(toolDef.timeoutMs, config);
  return mark(cloneWith(toolDef, { invoke, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }));
}

function wrapShell<T extends ShellLike>(toolDef: T, config: OkedAgentsConfig, deps: GateDeps): T {
  if (isHostedShell(toolDef)) {
    const log = config.log ?? ((message: string) => process.stderr.write(`[OKed] ${message}\n`));
    log(
      `cannot gate hosted shell tool "${toolDef.name}": the command runs outside this process. It was left unchanged.`,
    );
    return toolDef;
  }
  const previous = toolDef.onApproval;
  const name = toolDef.name || "shell";
  return mark(
    cloneWith(toolDef, {
      needsApproval: async () => true,
      onApproval: (runContext: unknown, approvalItem: unknown) => {
        const parsed = argsFromApprovalItem(approvalItem);
        const args = parsed.args.command !== undefined ? parsed.args : shellActionArgs(asObj(approvalItem).action);
        return onApprovalDecision(parsed.name || name, args, config, deps, runContext, previous, approvalItem);
      },
    }),
  );
}

function wrapPatch<T extends PatchLike>(toolDef: T, config: OkedAgentsConfig, deps: GateDeps): T {
  const previous = toolDef.onApproval;
  const name = toolDef.name || "apply_patch";
  return mark(
    cloneWith(toolDef, {
      needsApproval: async () => true,
      onApproval: (runContext: unknown, approvalItem: unknown) => {
        const parsed = argsFromApprovalItem(approvalItem);
        return onApprovalDecision(parsed.name || name, parsed.args, config, deps, runContext, previous, approvalItem);
      },
    }),
  );
}

function wrapHostedMcp<T extends HostedMcpLike>(toolDef: T, config: OkedAgentsConfig, deps: GateDeps): T {
  const providerData = { ...(toolDef.providerData ?? {}) };
  const previous = providerData.on_approval as ShellLike["onApproval"] | undefined;
  const serverLabel = typeof providerData.server_label === "string" ? providerData.server_label : "hosted_mcp";
  providerData.require_approval = "always";
  providerData.on_approval = (runContext: unknown, approvalItem: unknown) => {
    const parsed = argsFromApprovalItem(approvalItem);
    return onApprovalDecision(parsed.name || serverLabel, parsed.args, config, deps, runContext, previous, approvalItem);
  };
  return mark(cloneWith(toolDef, { providerData }));
}

function wrapOne<T extends Tool>(candidate: T, config: OkedAgentsConfig, deps: GateDeps): T {
  if (!candidate || typeof candidate !== "object" || typeof (candidate as { type?: unknown }).type !== "string") {
    throw new TypeError("withOkedTools() expected an OpenAI Agents SDK tool.");
  }
  if (isWrapped(candidate)) return candidate;
  const kind = (candidate as { type: string }).type;
  if (kind === "function" && typeof (candidate as FunctionLike).invoke === "function") {
    return wrapFunctionTool(candidate as unknown as FunctionLike, config, deps) as unknown as T;
  }
  if (kind === "shell") return wrapShell(candidate as unknown as ShellLike, config, deps) as unknown as T;
  if (kind === "apply_patch") return wrapPatch(candidate as unknown as PatchLike, config, deps) as unknown as T;
  if (
    kind === "hosted_tool" &&
    (candidate as HostedMcpLike).name === "hosted_mcp" &&
    (candidate as HostedMcpLike).providerData?.type === "mcp"
  ) {
    return wrapHostedMcp(candidate as unknown as HostedMcpLike, config, deps) as unknown as T;
  }
  return candidate;
}

type ToolExecute = (args: unknown, runContext?: unknown, details?: unknown) => unknown;

/**
 * Build one function tool whose execute waits for a person when the call is
 * sensitive. Safe and warning calls run immediately. A denial, a timeout, or
 * an error is returned to the model and execute is not called.
 *
 * Do not also set needsApproval. This wrapper is the approval. The SDK pause
 * would ask a second time, and only after your own code resumed the run.
 */
export function okedTool<Result = unknown>(
  options: {
    name?: string;
    description: string;
    parameters: unknown;
    execute: ToolExecute;
    timeoutMs?: number;
    outputSchema?: unknown;
    [key: string]: unknown;
  },
  config: OkedAgentsConfig = {},
): FunctionTool<unknown, any, Result> {
  const deps = createDeps(config);
  const userExecute = options.execute;
  if (typeof userExecute !== "function") {
    throw new TypeError("okedTool() requires an execute function.");
  }
  const hasOutputSchema = options.outputSchema !== undefined;
  let resolvedName = options.name || userExecute.name || "tool";
  const execute = async (args: unknown, runContext?: unknown, details?: unknown) => {
    const decision = await decideToolCall(resolvedName, asRecord(args), config, deps, runContext);
    if (!decision.proceed) return blockResult(decision.denial, hasOutputSchema, config);
    return userExecute(args, runContext, details);
  };
  if (userExecute.name) {
    Object.defineProperty(execute, "name", { value: userExecute.name });
  }
  const timeoutMs = raisedTimeout(options.timeoutMs, config);
  const { needsApproval: _needsApproval, timeoutMs: _timeoutMs, execute: _execute, ...rest } = options;
  const created = tool({
    ...rest,
    execute,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  } as Parameters<typeof tool>[0]);
  resolvedName = created.name || resolvedName;
  return mark(created) as FunctionTool<unknown, any, Result>;
}

/**
 * Wrap every tool in an agent tool list.
 *
 * Function tools are gated inside invoke. Local shell and apply_patch use
 * onApproval. Hosted MCP is set to require approval and resolved with
 * on_approval. Hosted shell, computer, and other hosted tools are returned
 * unchanged: this process cannot stop them. Gate those with needsApproval
 * and settleOkedInterruptions, or keep the risky work in a function tool.
 *
 * Wrapping a tool that is already wrapped is a no-op, so okedTool and
 * withOkedTools can be combined without asking twice.
 */
export function withOkedTools<T extends Tool>(tools: readonly T[], config: OkedAgentsConfig = {}): T[] {
  if (!Array.isArray(tools)) {
    throw new TypeError("withOkedTools() expected an array of tools.");
  }
  const deps = createDeps(config);
  return tools.map((item) => wrapOne(item, config, deps));
}

/**
 * Resolve an Agents SDK interruption list with OKed.
 *
 * Use this when tools already set needsApproval and you did not wrap them.
 * Approved calls are state.approve. Anything else is state.reject with a
 * message the model sees when you resume. Pending interruptions are not
 * left pending. Resume with run(agent, result.state).
 */
export async function settleOkedInterruptions(
  result: OkedRunLike,
  config: OkedAgentsConfig = {},
): Promise<{ settled: number }> {
  const interruptions = result.interruptions ?? [];
  if (interruptions.length === 0) return { settled: 0 };
  const deps = createDeps(config);
  for (const item of interruptions) {
    const parsed = argsFromApprovalItem(item);
    let message: string;
    try {
      const decision = await decideToolCall(parsed.name, parsed.args, config, deps, undefined);
      if (decision.proceed) {
        result.state.approve(item);
        continue;
      }
      message = decision.denial.message;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      message =
        `OKed: unexpected error while approving ${parsed.name} (${cause}). ` +
        "The tool did not run. This is a final decision. Do NOT retry the same action. " +
        "Stop and ask the user what to do instead.";
    }
    result.state.reject(item, { message });
  }
  return { settled: interruptions.length };
}
