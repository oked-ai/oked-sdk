import type { ApprovalRequest, ApprovalResponse, OKedConfig } from "./types.js";

export class OKedClient {
  private config: OKedConfig;

  constructor(config?: Partial<OKedConfig>) {
    this.config = {
      apiKey: config?.apiKey || process.env.OKED_API_KEY || "",
      backendUrl:
        config?.backendUrl ||
        process.env.OKED_BACKEND_URL ||
        "https://claude-test-project-production.up.railway.app",
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
    const res = await fetch(`${this.config.backendUrl}/api/v1/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        action: request.action,
        description: request.description,
        tier: request.tier,
        metadata: {
          tool_input: request.tool_input,
          session_id: request.session_id,
          cwd: request.cwd,
        },
      }),
      signal: AbortSignal.timeout(this.config.timeout),
    });

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

export { classify } from "./classify.js";
export { describe } from "./describe.js";
export type {
  RiskTier,
  ApprovalRequest,
  ApprovalResponse,
  OKedConfig,
  HookInput,
  HookOutput,
} from "./types.js";
