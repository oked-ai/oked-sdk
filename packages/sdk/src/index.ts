import type { ApprovalRequest, ApprovalResponse, OKedConfig } from "./types.js";
import { loadOKedConfig } from "./config.js";
import { OKedAuthError, OKedBackendUnreachableError } from "./errors.js";

function envStrictFailClosed(): boolean | undefined {
  const raw = process.env.OKED_STRICT_FAIL_CLOSED;
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

export class OKedClient {
  private config: OKedConfig;

  constructor(config?: Partial<OKedConfig>) {
    const persisted = loadOKedConfig();
    this.config = {
      apiKey: config?.apiKey || process.env.OKED_API_KEY || persisted.apiKey || "",
      backendUrl:
        config?.backendUrl ||
        process.env.OKED_BACKEND_URL ||
        persisted.backendUrl ||
        "https://api.oked.ai",
      timeout: config?.timeout || 300_000,
      // Precedence: constructor > env > ~/.oked/config.json > default false.
      strictFailClosed:
        config?.strictFailClosed ??
        envStrictFailClosed() ??
        persisted.strictFailClosed ??
        false,
    };
  }

  get strictFailClosed(): boolean {
    return this.config.strictFailClosed;
  }

  get apiKey(): string {
    return this.config.apiKey;
  }

  get backendUrl(): string {
    return this.config.backendUrl;
  }

  async approve(request: ApprovalRequest): Promise<ApprovalResponse> {
    const signal = AbortSignal.timeout(this.config.timeout);
    const doFetch = () =>
      fetch(`${this.config.backendUrl}/api/v1/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          action: request.action,
          description: request.description,
          tier: request.tier,
          fields: request.fields,
          metadata: {
            tool_input: request.tool_input,
            session_id: request.session_id,
            cwd: request.cwd,
          },
        }),
        signal,
      });

    let res: Response;
    try {
      try {
        res = await doFetch();
      } catch (err) {
        if (isRetriableConnectError(err)) {
          await new Promise((r) => setTimeout(r, 200));
          res = await doFetch();
        } else {
          throw err;
        }
      }
    } catch (err) {
      // Network failure or the request-level timeout firing (AbortError).
      // Both mean we never got a decision from the backend -> treat as an
      // outage so degraded-mode can apply.
      throw new OKedBackendUnreachableError(
        err instanceof Error ? `OKed backend unreachable: ${err.message}` : "OKed backend unreachable",
        err,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new OKedAuthError(`OKed backend error ${res.status}: ${body}`, res.status);
      }
      if (res.status >= 500) {
        throw new OKedBackendUnreachableError(`OKed backend error ${res.status}: ${body}`);
      }
      throw new Error(`OKed backend error ${res.status}: ${body}`);
    }

    const result = (await res.json()) as {
      approval_id: string;
      decision: string;
      status: string;
    };

    return {
      approved: result.decision === "approved",
      approval_id: result.approval_id,
      decision: result.decision as ApprovalResponse["decision"],
    };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.backendUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function isRetriableConnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

export { OKedAuthError, OKedBackendUnreachableError } from "./errors.js";
export { TIER_ORDER, degradedDecision } from "./degraded.js";
export { classify } from "./classify.js";
export { describe, describeFields } from "./describe.js";
export type { Rendered } from "./describe.js";
export { CLASSIFIER_VERSION } from "./kinds.js";
export type { OperationKind } from "./kinds.js";
export { loadOKedConfig, OKED_CONFIG_PATH } from "./config.js";
export type { PersistedConfig } from "./config.js";
export type {
  RiskTier,
  ApprovalRequest,
  ApprovalResponse,
  OKedConfig,
  HookInput,
  HookOutput,
} from "./types.js";
