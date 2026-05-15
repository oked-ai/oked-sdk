import type { ApprovalRequest, ApprovalResponse, OKedConfig } from "./types.js";
import { loadOKedConfig } from "./config.js";

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
    };
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
      res = await doFetch();
    } catch (err) {
      if (isRetriableConnectError(err)) {
        await new Promise((r) => setTimeout(r, 200));
        res = await doFetch();
      } else {
        throw err;
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
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
