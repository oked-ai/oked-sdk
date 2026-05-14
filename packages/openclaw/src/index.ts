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
 *   "minTier": "warning"                 // minimum tier to require approval (default: "warning")
 * }
 */

import { OKedClient, describe as describeAction, type RiskTier } from "@oked/sdk";
import { classifyOpenClawTool, type ClassifyOptions } from "./classify-openclaw.js";

const TIER_ORDER: Record<RiskTier, number> = {
  safe: 0,
  warning: 1,
  review: 2,
  high_stakes: 3,
};

const APPROVAL_TIERS: ReadonlySet<RiskTier> = new Set(["review", "high_stakes"]);

interface OkedPluginConfig extends ClassifyOptions {
  apiKey?: string;
  backendUrl?: string;
  minTier?: RiskTier;
  /** Approval timeout in ms; defaults to OKed backend default. */
  timeoutMs?: number;
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

      let tier: RiskTier;
      try {
        tier = classifyOpenClawTool(toolName, params, {
          alwaysApprove: cfg.alwaysApprove,
          alwaysAllow: cfg.alwaysAllow,
        });
      } catch (err) {
        // Classifier should never throw, but if it does, fail safe.
        log?.error?.(`[oked] classifier error on ${toolName}: ${String(err)}`);
        return { block: true, blockReason: "OKed classifier error. Fail-safe deny." };
      }

      // Below threshold or above-threshold-but-not-in-approval-set → allow.
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

      try {
        const result = await oked.approve({
          action: toolName,
          description,
          tier,
          tool_input: params,
          ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
          ...(ctx.sessionKey && !ctx.sessionId ? { session_id: ctx.sessionKey } : {}),
          cwd: process.cwd(),
        });

        if (result.approved) {
          log?.info?.(`[oked] ✓ approved ${toolName}`);
          return; // allow
        }

        log?.info?.(`[oked] ✗ ${result.decision}, blocking ${toolName}`);
        return {
          block: true,
          blockReason: `${result.decision} via OKed (approval ${result.approval_id})`,
        };
      } catch (err) {
        // Backend unreachable, network error, etc. Fail safe DENY.
        const msg = err instanceof Error ? err.message : String(err);
        log?.error?.(`[oked] approval request failed for ${toolName}: ${msg}. Fail-safe deny.`);
        return {
          block: true,
          blockReason: `OKed backend error, fail-safe deny: ${msg}`,
        };
      }
    });
  },
};

export default plugin;
export { classifyOpenClawTool } from "./classify-openclaw.js";
export type { OkedPluginConfig };
