import {
  OKedClient,
  classify,
  describe,
  describeFields,
  lookupPrTitle,
  applyRules,
  degradedDecision,
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
  effectiveMode,
  recordWouldHavePaused,
  shortReceiptId,
  type OkedMode,
  type WatchReason,
} from "@oked/sdk";
import { appendReceipt } from "./receipts.js";
import { errorInfo, logDecision, type DecisionLogEntry } from "./log.js";
import { claudeSandboxEnforced } from "./sandbox.js";

export interface ToolCallInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  sessionId?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface GateDecision {
  decision: PermissionDecision;
  /** Omitted when the host should continue with no reason text. */
  reason?: string;
}

export interface DecideOptions {
  /** Recorded on receipts and in the decision log, e.g. `@oked/claude-code@0.6.22`. */
  clientId: string;
  /** Receipt subject source, e.g. `claude-code`. */
  source: string;
  /**
   * What to do when this device has no API key.
   * Claude Code uses `ask` so the host's own prompt can decide.
   * Hosts that treat `ask` as allow, or that ignore it, must use `deny`.
   */
  unpaired?: "ask" | "deny";
  /** Reason returned to the host when unpaired. */
  unpairedReason: string;
  /** stderr line, without the `[OKed]` prefix, when unpaired. */
  unpairedLog: string;
  /**
   * Sentence for an invalid API key. The default matches `@oked/claude-code`.
   * Other hosts pass a sentence that names their own init command.
   */
  invalidKeyReason?: (status: number) => string;
  /**
   * When set to a non-empty string, this key is used instead of `OKED_API_KEY`
   * and `~/.oked/config.json`. The Claude Code plugin passes
   * `CLAUDE_PLUGIN_OPTION_APIKEY`.
   */
  apiKey?: string;
  log?: (msg: string) => void;
  /**
   * When set, overrides Claude Code sandbox detection.
   * `false`: an opaque code runner (test runner, script file, npx) is `review`.
   * `true`: those commands stay `safe`.
   * Omitted: `source: "claude-code"` reads sandbox settings. Other hosts omit
   * it and keep the previous behaviour.
   */
  sandboxEnforced?: boolean;
  /**
   * `watch` allows a call that would have paused and records it.
   * `enforce` is the default. When omitted, OKED_MODE and ~/.oked/config.json apply.
   */
  mode?: OkedMode;
}

type Context = Omit<DecisionLogEntry, "ts" | "decision" | "reason" | "client">;

function defaultInvalidKeyReason(status: number): string {
  return `OKed: invalid API key (HTTP ${status}). Run \`oked init\` to pair again, or \`oked uninstall\` to remove OKed.`;
}

function errorText(err: unknown): string {
  const info = errorInfo(err);
  return `${info.name}: ${info.message}`;
}

function commandOf(toolInput: Record<string, unknown>): string | undefined {
  const command = toolInput.command ?? toolInput.cmd;
  return typeof command === "string" ? command : undefined;
}

/**
 * Classify one tool call and, when the tier needs a person, wait for the
 * decision. Safe and warning calls return allow without a prompt, unless a
 * cached user rule matches. Receipts are checked by the SDK before an approval
 * counts. Explicit denials, auth failures, bad receipts, and unexpected errors
 * deny. An unreachable backend follows `degradedDecision`.
 *
 * In watch mode the same call is allowed and a line is appended to the watch
 * log. `approve()` is not called, so the action is not held and is not sent.
 *
 * This function does not write host output. The caller maps `decision` onto
 * the host's protocol. It does write the shared decision log and the local
 * receipt copy, matching `@oked/claude-code`.
 */
export async function decide(call: ToolCallInput, options: DecideOptions): Promise<GateDecision> {
  const log =
    options.log ??
    ((msg: string) => {
      process.stderr.write(`[OKed] ${msg}\n`);
    });
  const unpaired = options.unpaired ?? "deny";

  const finish = (decision: PermissionDecision, reason: string | undefined, ctx: Context): GateDecision => {
    if (decision !== "allow" || ctx.degraded) {
      logDecision({
        decision,
        reason: reason ?? "",
        client: options.clientId,
        ...ctx,
      });
    }
    return reason ? { decision, reason } : { decision };
  };

  const toolName = call.toolName;
  const toolInput = call.toolInput;
  const command = commandOf(toolInput);
  const sandboxEnforced =
    options.sandboxEnforced !== undefined
      ? options.sandboxEnforced
      : options.source === "claude-code"
        ? claudeSandboxEnforced(call.cwd ?? process.cwd(), command)
        : undefined;
  const tier = classify(
    toolName,
    toolInput,
    sandboxEnforced === undefined ? undefined : { sandboxEnforced },
  );
  const describeCtx = {
    cwd: call.cwd,
    ...(sandboxEnforced === false ? { sandboxEnforced: false as const } : {}),
  };
  const client = new OKedClient({
    client: options.clientId,
    source: options.source,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });

  // Presence ping (throttled to once/day on disk, never throws). Fired before
  // the safe/warning fast-path return so installs that only ever run safe
  // actions still register for retention. Bounded by the 3s internal timeout,
  // and only the once/day send actually waits.
  if (client.apiKey) await client.heartbeat();

  let fields = describeFields(toolName, toolInput, describeCtx) ?? undefined;

  // safe/warning normally short-circuit locally with no network call. But a
  // user rule can escalate (or auto-decide) such an action, and rules live
  // server-side. Consult the locally-cached rules: if one matches this action,
  // route it to the backend so the rule is applied authoritatively. With no
  // matching rule (the common case) we keep the cheap local fast-path.
  if (tier === "safe" || tier === "warning") {
    let ruleMatches = false;
    if (client.apiKey) {
      try {
        const rules = await client.getRules();
        if (rules.length > 0) {
          const decision = applyRules({ tier, fields: fields ?? {} }, rules, { cwd: call.cwd ?? "" });
          ruleMatches = Boolean(decision.appliedRuleId);
        }
      } catch {
        // Advisory: a failed rules lookup must never block the action.
      }
    }
    if (!ruleMatches) {
      if (tier === "warning") {
        const summary = (toolInput.file_path ?? toolInput.command ?? toolName) as string;
        process.stderr.write(`WARNING  OKed: ${toolName} ${summary} - allowed (inside project)\n`);
      }
      return { decision: "allow" };
    }
  }

  const ctx: Context = { tool: toolName, tier };

  // Watch replaces the pause. Safe and warning calls already returned above,
  // unless a saved rule would have sent them on. A classifier throw still
  // denies in the caller's fail-safe handler: this branch is only a classified
  // action that enforce mode would have paused or blocked.
  if (effectiveMode(options.mode, client.mode) === "watch") {
    const reason: WatchReason = !client.apiKey
      ? "would have paused (not paired)"
      : tier === "safe" || tier === "warning"
        ? "would have paused (saved rule)"
        : "would have paused";
    recordWouldHavePaused({
      tool: toolName,
      tier,
      client: options.clientId,
      source: options.source,
      reason,
    });
    log(`watch: ${toolName} (${tier}) ${reason}. Allowed.`);
    return { decision: "allow", reason: `OKed watch: ${reason}` };
  }

  if (!client.apiKey) {
    log(options.unpairedLog);
    return finish(unpaired, options.unpairedReason, ctx);
  }

  const prTitle = await lookupPrTitle(fields);
  if (prTitle) fields = describeFields(toolName, toolInput, { ...describeCtx, prTitle }) ?? undefined;

  const description = describe(toolName, toolInput, { ...describeCtx, prTitle });
  log(`${toolName}: "${description}" - ${tier}`);
  log("Requesting approval... (check your phone)");

  try {
    const result = await client.approve({
      action: toolName,
      description,
      tier,
      fields,
      tool_input: toolInput,
      session_id: call.sessionId,
      cwd: call.cwd,
    });

    if (result.receipt) appendReceipt(result.receipt);
    const receiptNote = result.receipt ? ` (receipt ${shortReceiptId(result.receipt.body.receipt_id)})` : "";

    const decided: Context = {
      ...ctx,
      approval_id: result.approval_id,
      receipt_id: result.receipt?.body.receipt_id ?? null,
    };
    if (result.approved) {
      log(`Approved (${result.approval_id})${receiptNote}`);
      return finish("allow", `Approved via OKed${receiptNote}`, decided);
    }
    if (result.decision === "timeout") {
      log(`No decision in time (${result.approval_id})${receiptNote}`);
      return finish("deny", `OKed: no decision within the approval window (timed out): ${description}`, decided);
    }
    log(`Denied (${result.approval_id})${receiptNote}`);
    return finish("deny", `Denied via OKed: ${description}`, decided);
  } catch (err) {
    const failed: Context = { ...ctx, error: errorInfo(err) };
    if (err instanceof OKedReceiptError) {
      log(`Approval receipt did not verify (${err.problems.join(", ")}) - action denied`);
      return finish(
        "deny",
        `OKed: the approval receipt did not verify (${err.problems.join(", ")}); action denied`,
        failed,
      );
    }
    if (err instanceof OKedAuthError) {
      log(`Invalid API key (HTTP ${err.status}) - action denied`);
      const reason = (options.invalidKeyReason ?? defaultInvalidKeyReason)(err.status);
      return finish("deny", reason, failed);
    }
    if (err instanceof OKedTooManyPendingError) {
      log(`Too many pending approvals (HTTP 429) - action denied`);
      return finish("deny", err.message, failed);
    }
    if (err instanceof OKedHttpError) {
      log(`Backend error HTTP ${err.status} - action denied (fail-safe)`);
      return finish(
        "deny",
        `OKed: backend error HTTP ${err.status}${err.detail ? `: ${err.detail}` : ""} (fail-safe deny)`,
        failed,
      );
    }
    if (err instanceof OKedBackendUnreachableError) {
      const decision = degradedDecision(tier, {
        strictFailClosed: client.strictFailClosed,
      });
      const cause = errorInfo(err).message;
      if (decision === "allow") {
        log(`Backend unreachable (${cause}) - allowed (degraded; ${tier}, non-high-stakes)`);
        return finish(
          "allow",
          `OKed backend unreachable (${cause}) - allowed (degraded; non-high-stakes)`,
          { ...failed, degraded: true },
        );
      }
      const why = client.strictFailClosed ? "strict fail-closed" : "high-stakes";
      log(`Backend unreachable (${cause}) - ${why} denied (fail-safe)`);
      return finish("deny", `OKed backend unreachable (${cause}) - ${why} denied (fail-safe)`, failed);
    }
    log(`Unexpected error (${errorText(err)}) - action denied (fail-safe)`);
    return finish("deny", `OKed: unexpected error (fail-safe): ${errorText(err)}`, failed);
  }
}
