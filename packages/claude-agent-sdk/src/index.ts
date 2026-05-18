/**
 * @oked/claude-agent-sdk — OKed for the Claude Agent SDK.
 *
 * Exports a ready-made `PreToolUse` hook callback. Wire it into your agent's
 * `options.hooks` and every tool call the model makes is classified; calls
 * classified as sensitive (review / high_stakes) freeze the agent and wait
 * for a human approval via the OKed backend (push to your phone). The tool
 * only runs on Approve.
 *
 * Unlike `@oked/claude-code` there is no `.claude/settings.json` install —
 * the Claude Agent SDK takes hooks programmatically. Bring your own API key
 * via `OKED_API_KEY` (or `~/.oked/config.json`); see README.
 *
 * Failure semantics mirror the other OKed integrations: fail safe. Auth
 * errors deny; backend-unreachable degrades per tier (`degradedDecision`);
 * any unexpected error denies. Never let an agent proceed when in doubt.
 */
import {
  OKedClient,
  classify,
  describe,
  describeFields,
  degradedDecision,
  OKedAuthError,
  OKedBackendUnreachableError,
} from "@oked/sdk";
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

function log(msg: string): void {
  process.stderr.write(`[OKed] ${msg}\n`);
}

const ALLOW = {};

function deny(reason: string) {
  return {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function ask() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "ask" as const,
    },
  };
}

/**
 * A `PreToolUse` hook callback for the Claude Agent SDK. Pass it via
 * `options.hooks` (or use {@link okedHooks}).
 */
export const okedPreToolUseHook: HookCallback = async (rawInput) => {
  const input = rawInput as PreToolUseHookInput;
  const toolName = input.tool_name;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

  const tier = classify(toolName, toolInput);

  // Safe — allow immediately, no network call.
  if (tier === "safe") return ALLOW;

  // Warning — allow, log only, no network call (mirrors the Claude Code hook).
  if (tier === "warning") {
    const summary = (toolInput.file_path ?? toolInput.command ?? toolName) as string;
    log(`WARNING ${toolName} ${summary} - allowed (inside project)`);
    return ALLOW;
  }

  const client = new OKedClient();
  if (!client.apiKey) {
    log("OKED_API_KEY not set - deferring to the agent's built-in permission flow.");
    return ask();
  }

  const description = describe(toolName, toolInput);
  const fields = describeFields(toolName, toolInput) ?? undefined;
  log(`${toolName}: "${description}" - ${tier}`);
  log("Requesting approval... (check your phone)");

  try {
    const result = await client.approve({
      action: toolName,
      description,
      tier,
      fields,
      tool_input: toolInput,
      session_id: input.session_id,
      cwd: input.cwd,
    });

    if (result.approved) {
      log(`Approved (${result.approval_id})`);
      return ALLOW;
    }
    log(`Denied (${result.approval_id})`);
    return deny(`Denied via OKed: ${description}`);
  } catch (err) {
    if (err instanceof OKedAuthError) {
      // Auth misconfig is not an outage — always deny.
      log("Invalid API key - action denied");
      return deny("OKed: invalid API key");
    }
    if (err instanceof OKedBackendUnreachableError) {
      const decision = degradedDecision(tier, {
        strictFailClosed: client.strictFailClosed,
      });
      if (decision === "allow") {
        log(`Backend unreachable - allowed (degraded; ${tier}, non-high-stakes)`);
        return ALLOW;
      }
      const why = client.strictFailClosed ? "strict fail-closed" : "high-stakes";
      log(`Backend unreachable - ${why} denied (fail-safe)`);
      return deny(`OKed backend unreachable - ${why} denied (fail-safe)`);
    }
    log("Unexpected error - action denied (fail-safe)");
    return deny("OKed: unexpected error (fail-safe)");
  }
};

/**
 * Convenience: spread into the Claude Agent SDK `options.hooks`.
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { okedHooks } from "@oked/claude-agent-sdk";
 *
 * for await (const m of query({ prompt, options: { hooks: okedHooks() } })) { }
 * ```
 */
export function okedHooks() {
  return { PreToolUse: [{ hooks: [okedPreToolUseHook] }] };
}
