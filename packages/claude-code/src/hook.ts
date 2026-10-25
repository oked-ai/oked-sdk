#!/usr/bin/env node
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
  shortReceiptId,
} from "@oked/sdk";
import type { HookInput, HookOutput } from "@oked/sdk";
import { CLIENT_ID } from "./version.js";
import { appendReceipt } from "./receipts.js";
import { logDecision, errorInfo, type DecisionLogEntry } from "./hook-log.js";

function makeOutput(
  decision: "allow" | "deny" | "ask",
  reason?: string
): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason && { permissionDecisionReason: reason }),
    },
  };
}

function log(msg: string): void {
  process.stderr.write(`[OKed] ${msg}\n`);
}

type Context = Omit<DecisionLogEntry, "ts" | "decision" | "reason" | "client">;

/**
 * Writes the hook output. Every deny and ask, and every degraded allow, also
 * goes to ~/.oked/hook.log.
 */
function respond(decision: "allow" | "deny" | "ask", reason: string | undefined, ctx: Context): void {
  process.stdout.write(JSON.stringify(makeOutput(decision, reason)));
  if (decision !== "allow" || ctx.degraded) logDecision({ decision, reason: reason ?? "", client: CLIENT_ID, ...ctx });
}

/** "Name: message", one line, short. For deny reasons. */
function errorText(err: unknown): string {
  const e = errorInfo(err);
  return `${e.name}: ${e.message}`;
}

async function main(): Promise<void> {
  // Read hook input from stdin
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    // Can't parse input - don't break Claude, let it through
    process.stdout.write(JSON.stringify(makeOutput("allow")));
    return;
  }

  const { tool_name: toolName, tool_input: toolInput } = input;

  // Classify risk
  const tier = classify(toolName, toolInput);

  const client = new OKedClient({ client: CLIENT_ID, source: "claude-code" });

  // Presence ping (throttled to once/day on disk, never throws). Fired before
  // the safe/warning fast-path return so installs that only ever run safe
  // actions still register for retention. Bounded by the 3s internal timeout,
  // and only the once/day send actually waits.
  if (client.apiKey) await client.heartbeat();

  let fields = describeFields(toolName, toolInput, { cwd: input.cwd }) ?? undefined;

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
          const decision = applyRules({ tier, fields: fields ?? {} }, rules, { cwd: input.cwd });
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
      process.stdout.write(JSON.stringify(makeOutput("allow")));
      return;
    }
    // A rule matched a normally-silent action — fall through to the backend,
    // which applies the rule authoritatively (escalate / auto-decide + audit).
  }

  const ctx: Context = { tool: toolName, tier };

  // Check if API key is configured
  if (!client.apiKey) {
    log("not paired - run `oked init` to pair this device. Falling back to Claude's built-in prompt.");
    respond("ask", "OKed: this device is not paired. Run `oked init`.", ctx);
    return;
  }

  // A PR card names the PR. Ask GitHub for the title when the command does not say it.
  const prTitle = await lookupPrTitle(fields);
  if (prTitle) fields = describeFields(toolName, toolInput, { cwd: input.cwd, prTitle }) ?? undefined;

  // Generate human-readable description
  const description = describe(toolName, toolInput, { cwd: input.cwd, prTitle });
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

    // Keep our own copy of every verified receipt (approve, deny or timeout).
    if (result.receipt) appendReceipt(result.receipt);
    const receiptNote = result.receipt ? ` (receipt ${shortReceiptId(result.receipt.body.receipt_id)})` : "";

    const decided: Context = {
      ...ctx,
      approval_id: result.approval_id,
      receipt_id: result.receipt?.body.receipt_id ?? null,
    };
    if (result.approved) {
      log(`Approved (${result.approval_id})${receiptNote}`);
      respond("allow", `Approved via OKed${receiptNote}`, decided);
    } else if (result.decision === "timeout") {
      log(`No decision in time (${result.approval_id})${receiptNote}`);
      respond("deny", `OKed: no decision within the approval window (timed out): ${description}`, decided);
    } else {
      log(`Denied (${result.approval_id})${receiptNote}`);
      respond("deny", `Denied via OKed: ${description}`, decided);
    }
  } catch (err) {
    const failed: Context = { ...ctx, error: errorInfo(err) };
    if (err instanceof OKedReceiptError) {
      // A decision we cannot prove is not a decision - always deny.
      log(`Approval receipt did not verify (${err.problems.join(", ")}) - action denied`);
      respond("deny", `OKed: the approval receipt did not verify (${err.problems.join(", ")}); action denied`, failed);
    } else if (err instanceof OKedAuthError) {
      // Auth misconfig is not an outage - always deny.
      log(`Invalid API key (HTTP ${err.status}) - action denied`);
      respond("deny", `OKed: invalid API key (HTTP ${err.status}). Run \`oked init\` to pair again.`, failed);
    } else if (err instanceof OKedTooManyPendingError) {
      // Not an outage: the backend works, and too many approvals wait.
      log(`Too many pending approvals (HTTP 429) - action denied`);
      respond("deny", err.message, failed);
    } else if (err instanceof OKedHttpError) {
      log(`Backend error HTTP ${err.status} - action denied (fail-safe)`);
      respond("deny", `OKed: backend error HTTP ${err.status}${err.detail ? `: ${err.detail}` : ""} (fail-safe deny)`, failed);
    } else if (err instanceof OKedBackendUnreachableError) {
      const decision = degradedDecision(tier, {
        strictFailClosed: client.strictFailClosed,
      });
      const cause = errorInfo(err).message;
      if (decision === "allow") {
        log(`Backend unreachable (${cause}) - allowed (degraded; ${tier}, non-high-stakes)`);
        respond("allow", `OKed backend unreachable (${cause}) - allowed (degraded; non-high-stakes)`, { ...failed, degraded: true });
      } else {
        const why = client.strictFailClosed
          ? "strict fail-closed"
          : "high-stakes";
        log(`Backend unreachable (${cause}) - ${why} denied (fail-safe)`);
        respond("deny", `OKed backend unreachable (${cause}) - ${why} denied (fail-safe)`, failed);
      }
    } else {
      // Unknown error - fail safe deny, with the real cause.
      log(`Unexpected error (${errorText(err)}) - action denied (fail-safe)`);
      respond("deny", `OKed: unexpected error (fail-safe): ${errorText(err)}`, failed);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[OKed] Fatal: ${err}\n`);
  // Fail-safe: deny, with the real cause.
  respond("deny", `OKed: internal error (fail-safe): ${errorText(err)}`, { tool: "unknown", tier: null, error: errorInfo(err) });
  process.exit(0); // exit 0 so Claude reads our JSON, not a crash
});
