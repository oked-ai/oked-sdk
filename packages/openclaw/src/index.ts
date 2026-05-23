/**
 * @oked/openclaw. OKed plugin for OpenClaw.
 *
 * Registers a `before_tool_call` hook that runs for *every* tool the agent
 * invokes (built-in or skill-registered). For tool calls classified as
 * sensitive, the hook freezes the agent and asks for a human approval via
 * the OKed backend (push to your phone). The agent only proceeds on Approve;
 * any other outcome blocks the call.
 *
 * Failure semantics: fail safe always. If the OKed backend is unreachable,
 * if the approval times out, or if the response is malformed, the tool call
 * is denied. Never let an agent proceed when in doubt.
 *
 * Plugin config (set in openclaw.json under plugins.entries.oked):
 * {
 *   "apiKey": "ok_...",                  // OKed API key (or OKED_API_KEY env)
 *   "backendUrl": "https://...",         // optional override
 *   "alwaysApprove": ["custom_tool"],    // additional names to require approval for
 *   "alwaysAllow":   ["safe_tool"],      // names to never gate
 *   "minTier": "review"                  // minimum tier to require approval (default: "review")
 * }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OKedClient,
  describe as describeAction,
  degradedDecision,
  OKedAuthError,
  OKedBackendUnreachableError,
  TIER_ORDER,
  type RiskTier,
} from "@oked/sdk";
import { classifyOpenClawTool, type ClassifyOptions } from "./classify-openclaw.js";

const MAX_SCRIPT_READ = 4096;

function tryReadScriptFile(command: string): string | undefined {
  // Match: python3 script.py, node script.js, ruby script.rb, etc.
  // Skip -c/-e flags (handled by findSqlInCommand inline path).
  const m = command.trim().match(
    /\b(?:python\d?(?:\.\d+)?|node|ruby|perl|deno\s+run|bun\s+run)\s+(?:-[^\s]+\s+)*(['"]?)([^\s'"]+\.(?:py|js|mjs|ts|rb|pl))\1/,
  );
  if (!m) return undefined;
  let target = m[2];
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
  else if (!path.isAbsolute(target)) target = path.resolve(target);
  try {
    const fd = fs.openSync(target, "r");
    const buf = Buffer.alloc(MAX_SCRIPT_READ);
    const bytesRead = fs.readSync(fd, buf, 0, MAX_SCRIPT_READ, 0);
    fs.closeSync(fd);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  }
}

function tryStatRmTarget(command: string): number | undefined {
  const m = command.trim().match(/\b(?:rm|trash|trash-put|rmdir)\s+(?:-[^\s]+\s+)*(['"]?)([^\s'"]+)\1/);
  if (!m) return undefined;
  let target = m[2];
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
  try {
    return fs.statSync(target).size;
  } catch {
    return undefined;
  }
}

const APPROVAL_TIERS: ReadonlySet<RiskTier> = new Set(["review", "high_stakes"]);

interface OkedPluginConfig extends ClassifyOptions {
  apiKey?: string;
  backendUrl?: string;
  minTier?: RiskTier;
  /** Approval timeout in ms; defaults to OKed backend default. */
  timeoutMs?: number;
  /**
   * When true, an unreachable backend hard-denies every sensitive tool call.
   * When false (default), it degrades to allow for non-high-stakes tiers so a
   * single outage does not mass-abort the agent. high_stakes always denies.
   */
  strictFailClosed?: boolean;
}

interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

interface BeforeToolCallContext {
  toolName: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
}

interface BeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
}

interface PluginLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface OpenClawPluginApi {
  pluginConfig?: OkedPluginConfig;
  logger?: PluginLogger;
  on: (
    hookName: string,
    handler: (
      event: BeforeToolCallEvent,
      ctx: BeforeToolCallContext,
    ) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void,
  ) => void;
}

/**
 * Thrown to abort a tool call OKed denied.
 *
 * Why throw instead of only returning `{ block: true }`: a returned block
 * directive is silently ignored unless the host recognizes that exact shape,
 * which fails OPEN (observed in production: a denied `rm` still executed). A
 * thrown exception from a pre-execution hook is the most universally honored
 * "abort" signal across plugin/hook runtimes, so it is the safe default for a
 * trust tool. `okedBlock`/`blockReason` are kept on the error so hosts that
 * DO inspect a structured result still get one.
 *
 * Caveat: if the host fires `before_tool_call` without awaiting the async
 * handler, neither a throw nor a return can stop the call - that is a host
 * bug OKed cannot fix from the plugin side.
 */
export class OkedDeniedError extends Error {
  readonly okedBlock = true as const;
  readonly blockReason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "OkedDeniedError";
    this.blockReason = reason;
  }
}

const PLUGIN_ID = "oked";

const plugin = {
  id: PLUGIN_ID,
  name: "OKed Approvals",
  description:
    "Freeze the agent before sensitive tool calls and ask for human approval via the OKed mobile app.",

  register(api: OpenClawPluginApi): void {
    const cfg = api.pluginConfig ?? {};
    const log = api.logger;

    const oked = new OKedClient({
      apiKey: cfg.apiKey ?? process.env.OKED_API_KEY,
      backendUrl: cfg.backendUrl ?? process.env.OKED_BACKEND_URL,
      ...(cfg.timeoutMs ? { timeout: cfg.timeoutMs } : {}),
      ...(cfg.strictFailClosed !== undefined
        ? { strictFailClosed: cfg.strictFailClosed }
        : {}),
    });

    if (!oked.apiKey) {
      log?.warn?.(
        `[oked] no apiKey configured. Plugin will fail-safe DENY every sensitive tool call. ` +
          `Set OKED_API_KEY env var or plugins.entries.oked.apiKey in openclaw.json.`,
      );
    }

    // minTier resolution order: openclaw.json > OKED_MIN_TIER env var > default.
    // (The env-var fallback exists because some OpenClaw versions reject
    // unknown keys under plugins.entries.<id>, so cfg.minTier is unavailable.)
    const envMinTier = process.env.OKED_MIN_TIER as RiskTier | undefined;
    const resolvedMinTier =
      cfg.minTier ?? (envMinTier && envMinTier in TIER_ORDER ? envMinTier : undefined) ?? "review";
    const minTier: RiskTier = resolvedMinTier;
    const minTierLevel = TIER_ORDER[minTier];

    api.on("before_tool_call", async (event, ctx) => {
      const { toolName, params } = event;

      // Why return `{ block: true, blockReason }` instead of throwing:
      // OpenClaw's `runBeforeToolCallHook` wraps any thrown error - even our
      // OkedDeniedError - into a generic `kind: "failure"` outcome and
      // overwrites the reason with the hardcoded string
      // "Tool call blocked because before_tool_call hook failed". That generic
      // string is what reaches the LLM, which reads it as a transient
      // tool-runtime error and retries the SAME denied action (observed in
      // production: 17 retries of a denied DELETE).
      //
      // Returning `{ block: true, blockReason }` instead routes through the
      // host's `kind: "veto"` path: the tool is NOT executed, AND our reason
      // is surfaced verbatim to the agent via `buildBlockedToolResult`. So
      // the LLM actually reads our "do NOT retry, ask the user" instruction.
      //
      // History: an earlier OpenClaw build did not honor a returned veto
      // (the tool ran anyway), which is why this code originally threw. The
      // current host (v2026.5.4+) correctly blocks on the return path - it
      // builds a blocked tool result without ever calling `tool.execute`.
      const deny = (reason: string): BeforeToolCallResult => {
        log?.info?.(`[oked] X blocking ${toolName}: ${reason}`);
        return { block: true, blockReason: reason };
      };

      let tier: RiskTier;
      try {
        tier = classifyOpenClawTool(toolName, params, {
          alwaysApprove: cfg.alwaysApprove,
          alwaysAllow: cfg.alwaysAllow,
        });
      } catch (err) {
        // Classifier should never throw, but if it does, fail safe.
        log?.error?.(`[oked] classifier error on ${toolName}: ${String(err)}`);
        return deny("OKed classifier error. Fail-safe deny.");
      }

      // Warning is informational only; only review/high_stakes can block.
      if (TIER_ORDER[tier] < minTierLevel || !APPROVAL_TIERS.has(tier)) {
        return; // void = allow
      }

      // Sensitive. Ask the human.
      const description = describeAction(toolName, params);
      log?.info?.(
        `[oked] requesting approval: tool=${toolName} tier=${tier} session=${
          ctx.sessionKey ?? ctx.sessionId ?? "?"
        }`,
      );

      // Enrich tool_input with file size for delete operations so the backend
      // can display it in the approval card (same as Create file shows size).
      let enrichedParams = params;
      const lowerTool = toolName.toLowerCase();
      if (lowerTool === "bash" || lowerTool === "shell" || lowerTool === "exec") {
        const cmd = (params.command ?? params.cmd) as string | undefined;
        if (typeof cmd === "string") {
          const sizeBytes = tryStatRmTarget(cmd);
          if (sizeBytes !== undefined) enrichedParams = { ...params, _file_size_bytes: sizeBytes };
          const scriptBody = tryReadScriptFile(cmd);
          if (scriptBody !== undefined) enrichedParams = { ...enrichedParams, _script_body: scriptBody };
        }
      }

      // Compute the outcome first; only throw/return AFTER the try/catch so a
      // deny is never swallowed by this block's own catch.
      let outcome: "allow" | string;
      try {
        const result = await oked.approve({
          action: toolName,
          description,
          tier,
          tool_input: enrichedParams,
          ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
          ...(ctx.sessionKey && !ctx.sessionId ? { session_id: ctx.sessionKey } : {}),
          cwd: process.cwd(),
        });
        if (result.approved) {
          outcome = "allow";
        } else {
          // Phrase the denial as an explicit instruction to the agent. A terse
          // "denied via OKed" message gets interpreted as a transient tool
          // error and the agent retries (observed: 17 retries of the same
          // DELETE before the agent gave up). Spell out that this is a final
          // human decision so the LLM stops looping.
          const verb = result.decision === "timeout" ? "did not respond to" : "DENIED";
          outcome =
            `USER ${verb} this action via OKed (approval ${result.approval_id}). ` +
            `This is a final human decision - do NOT retry the same action. ` +
            `Stop and ask the user what to do instead.`;
        }
      } catch (err) {
        if (err instanceof OKedAuthError) {
          // Auth misconfig is not an outage - always deny.
          log?.error?.(`[oked] invalid API key for ${toolName}.`);
          outcome =
            "OKed: invalid API key (configuration error, not a transient failure). " +
            "Do NOT retry. Stop and report this to the user.";
        } else if (err instanceof OKedBackendUnreachableError) {
          const decision = degradedDecision(tier, {
            strictFailClosed: oked.strictFailClosed,
          });
          if (decision === "allow") {
            // OpenClaw has no native "ask"; degraded non-high-stakes proceeds.
            log?.warn?.(
              `[oked] backend unreachable - ${toolName} (${tier}) allowed (degraded; non-high-stakes)`,
            );
            outcome = "allow";
          } else {
            const why = oked.strictFailClosed ? "strict fail-closed" : "high-stakes";
            log?.error?.(
              `[oked] backend unreachable - ${toolName} (${tier}) denied (${why}, fail-safe)`,
            );
            outcome =
              `OKed backend unreachable - this ${tier} action is denied (${why}, fail-safe). ` +
              `Do NOT retry. Stop and ask the user how to proceed.`;
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          log?.error?.(`[oked] approval request failed for ${toolName}: ${msg}.`);
          outcome =
            `OKed backend error, fail-safe deny: ${msg}. ` +
            `Do NOT retry. Stop and ask the user how to proceed.`;
        }
      }

      if (outcome === "allow") {
        log?.info?.(`[oked] OK ${toolName} allowed`);
        return; // allow
      }
      return deny(outcome); // throws OkedDeniedError - strongest abort signal
    });
  },
};

export default plugin;
export { classifyOpenClawTool } from "./classify-openclaw.js";
export type { OkedPluginConfig };
