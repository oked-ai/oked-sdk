/**
 * @oked/ai-sdk. OKed for the Vercel AI SDK.
 *
 * AI SDK 7 asks for approval through `toolApproval` on `generateText`,
 * `streamText`, and `ToolLoopAgent`. `okedToolApproval()` awaits
 * `OKedClient.approve()` and returns `approved` or `denied` in that same
 * call. A denial or a timeout is `{ type: "denied", reason }`. The AI SDK
 * then skips `execute` and shows the reason to the model.
 *
 * `user-approval` is intentionally unused. That status ends the generation
 * and leaves the tool runnable until some later call answers it.
 *
 * `withOked` and `okedTools` wrap `execute` for one tool or a tools object.
 * Use those when the gate has to travel with the tool, or on AI SDK 5 and 6,
 * which have no `toolApproval`. Do not also set `toolApproval` on a wrapped
 * tool: the person would be asked twice.
 *
 * Denied, timed out, and failed approvals do not run the tool.
 */
import { createGate, unexpectedMessage, type GateCall } from "./gate.js";
import type {
  OkedAiOptions,
  OkedDenial,
  OkedGateResult,
  OkedSingleToolApproval,
  OkedToolApprovalArgs,
  OkedToolApprovalFunction,
  OkedToolApprovalResult,
  OkedToolCall,
  ToolExecute,
} from "./types.js";
import type { RiskTier } from "@oked/sdk";

export type {
  OkedAiOptions,
  OkedDenial,
  OkedGateClient,
  OkedGateResult,
  OkedSingleToolApproval,
  OkedToolApprovalArgs,
  OkedToolApprovalFunction,
  OkedToolApprovalResult,
  OkedToolCall,
} from "./types.js";
export type { RiskTier } from "@oked/sdk";

const TIERS: ReadonlySet<RiskTier> = new Set(["safe", "warning", "review", "high_stakes"]);

/**
 * Thrown when a wrapped tool has an `outputSchema` and the call is denied.
 * The AI SDK turns the error into a tool error, so the schema does not
 * replace the reason with a validation failure. `message` is the reason
 * the model should read.
 */
export class OkedDeniedError extends Error {
  readonly oked = "denied" as const;
  readonly decision: OkedDenial["decision"];
  readonly approvalId: string | null;
  readonly reason: string;
  readonly tier: RiskTier;
  constructor(denial: OkedDenial) {
    super(denial.reason);
    this.name = "OkedDeniedError";
    this.decision = denial.decision;
    this.approvalId = denial.approvalId;
    this.reason = denial.reason;
    this.tier = denial.tier;
  }
}

export function isOkedDenial(value: unknown): value is OkedDenial {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<OkedDenial>;
  return (
    v.oked === "denied" &&
    (v.decision === "denied" || v.decision === "timeout" || v.decision === "error") &&
    typeof v.reason === "string" &&
    (typeof v.approvalId === "string" || v.approvalId === null) &&
    typeof v.tier === "string" &&
    TIERS.has(v.tier)
  );
}

function toDenial(result: Extract<OkedGateResult, { action: "deny" }>): OkedDenial {
  return {
    oked: "denied",
    decision: result.decision,
    approvalId: result.approvalId,
    reason: result.reason,
    tier: result.tier,
  };
}

/** Map a gate result onto an AI SDK 7 `toolApproval` status. */
function toToolApprovalStatus(result: OkedGateResult): OkedToolApprovalResult {
  if (result.action === "deny") return { type: "denied", reason: result.reason };
  if (result.recorded) return { type: "approved", reason: result.reason };
  return undefined;
}

function readInput(toolCall: OkedToolCall): unknown {
  if (toolCall.input !== undefined) return toolCall.input;
  return toolCall.args;
}

async function gated(
  gate: (call: GateCall) => Promise<OkedGateResult>,
  call: GateCall,
): Promise<OkedGateResult> {
  try {
    return await gate(call);
  } catch (err) {
    return {
      action: "deny",
      decision: "error",
      approvalId: null,
      reason: unexpectedMessage(err),
      tier: "review",
    };
  }
}

/**
 * `toolApproval` callback for every tool on a `generateText`, `streamText`,
 * or `ToolLoopAgent` call.
 *
 * ```ts
 * await generateText({
 *   model,
 *   tools,
 *   toolApproval: okedToolApproval(),
 *   prompt,
 * });
 * ```
 *
 * A sensitive call waits for a person. Approve returns `{ type: "approved" }`
 * and the AI SDK runs `execute`. Deny or timeout returns `{ type: "denied", reason }`
 * and `execute` does not run. `safe` and `warning` return `undefined` so the
 * tool runs with no approval metadata, unless a rule or `alwaysApprove` says
 * otherwise.
 */
export function okedToolApproval(options: OkedAiOptions = {}): OkedToolApprovalFunction {
  const gate = createGate(options);
  return async (args: OkedToolApprovalArgs = {}) => {
    const toolCall = args.toolCall;
    const result = await gated(gate, {
      toolName: typeof toolCall?.toolName === "string" ? toolCall.toolName : "",
      input: toolCall ? readInput(toolCall) : undefined,
      toolCallId: typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : undefined,
    });
    return toToolApprovalStatus(result);
  };
}

/**
 * Per-tool `toolApproval` entry. Tools you leave off the map are not gated.
 * Prefer {@link okedToolApproval} so every tool is classified.
 *
 * ```ts
 * toolApproval: { runCommand: okedToolApprovalFor("runCommand") }
 * ```
 */
export function okedToolApprovalFor(
  toolName: string,
  options: OkedAiOptions = {},
): OkedSingleToolApproval {
  const name = toolName.trim();
  const gate = createGate(options);
  return async (input, execOptions) => {
    const result = await gated(gate, {
      toolName: name,
      input,
      toolCallId: typeof execOptions?.toolCallId === "string" ? execOptions.toolCallId : undefined,
    });
    return toToolApprovalStatus(result);
  };
}

function hasOutputSchema(toolDef: object): boolean {
  return "outputSchema" in toolDef && (toolDef as { outputSchema?: unknown }).outputSchema != null;
}

function wrapExecute<T extends { execute?: ToolExecute }>(
  toolDef: T,
  name: string,
  gate: (call: GateCall) => Promise<OkedGateResult>,
): T {
  const execute = toolDef.execute;
  if (typeof execute !== "function") {
    throw new Error(
      `OKed: tool "${name}" has no execute function, so a wrapper cannot stop it. ` +
        "Provider-executed tools are not gated. Use okedToolApproval() for tools the AI SDK executes locally.",
    );
  }
  const validateOutput = hasOutputSchema(toolDef);
  const copy = { ...toolDef } as T & { needsApproval?: unknown };
  delete copy.needsApproval;
  copy.execute = async (input: unknown, execOptions?: unknown) => {
    const toolCallId =
      execOptions && typeof execOptions === "object"
        ? (execOptions as { toolCallId?: unknown }).toolCallId
        : undefined;
    const result = await gated(gate, {
      toolName: name,
      input,
      toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
    });
    if (result.action === "allow") {
      return await execute.call(toolDef, input, execOptions);
    }
    const denial = toDenial(result);
    if (validateOutput) throw new OkedDeniedError(denial);
    return denial;
  };
  return copy;
}

/**
 * Wrap one tool's `execute`. The original tool is not modified.
 * `name` is the tool name the model uses (the key in your tools object).
 *
 * On approve, `execute` is called with the same input and the same options
 * object. On deny, timeout, or error, `execute` is not called. The return
 * value is an {@link OkedDenial} unless the tool defines `outputSchema`, in
 * which case {@link OkedDeniedError} is thrown so schema validation cannot
 * hide the reason.
 */
export function withOked<T extends { execute?: ToolExecute }>(
  toolDef: T,
  options: OkedAiOptions & { name: string },
): T {
  const name = options.name?.trim() ?? "";
  if (!name) throw new Error("OKed: withOked requires a tool name.");
  if (!toolDef || typeof toolDef.execute !== "function") {
    throw new Error(
      `OKed: tool "${name}" has no execute function, so a wrapper cannot stop it. ` +
        "Provider-executed tools are not gated. Use okedToolApproval() for tools the AI SDK executes locally.",
    );
  }
  return wrapExecute(toolDef, name, createGate(options));
}

/**
 * Wrap every tool in a tools object that has `execute`. Tools without
 * `execute` are copied through and a log line says they are not gated.
 * One client is shared across the set.
 */
export function okedTools<T extends Record<string, { execute?: ToolExecute } | undefined>>(
  tools: T,
  options: OkedAiOptions = {},
): T {
  const gate = createGate(options);
  const log = options.log ?? ((message: string) => process.stderr.write(`[OKed] ${message}\n`));
  const out = {} as T;
  for (const name of Object.keys(tools)) {
    const toolDef = tools[name];
    if (!toolDef || typeof toolDef !== "object" || typeof toolDef.execute !== "function") {
      log(
        `tool "${name}" has no execute function, so it is not gated. ` +
          "Provider-executed tools run on the provider and OKed cannot stop them.",
      );
      out[name as keyof T] = toolDef as T[keyof T];
      continue;
    }
    out[name as keyof T] = wrapExecute(toolDef, name, gate) as T[keyof T];
  }
  return out;
}
