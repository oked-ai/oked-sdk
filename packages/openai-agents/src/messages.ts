import type { RiskTier } from "@oked/sdk";

/** Why a tool call was stopped. `error` covers auth, receipt, HTTP, and unexpected failures. */
export type OkedStopDecision = "denied" | "timeout" | "error";

/** What the model should see when a tool does not run. */
export interface OkedDenial {
  toolName: string;
  tier: RiskTier;
  decision: OkedStopDecision;
  /** Null when the request never got an id (for example a client-side timeout). */
  approvalId: string | null;
  /** Text returned to the model. The tool did not run. */
  message: string;
}

/**
 * Thrown when a denied tool declares an output schema and no `deniedOutput`
 * was given. A free-form string would fail that schema, so the run stops
 * instead of executing the tool or inventing a structured success.
 */
export class OkedToolDeniedError extends Error {
  readonly toolName: string;
  readonly tier: RiskTier;
  readonly decision: OkedStopDecision;
  readonly approvalId: string | null;

  constructor(denial: OkedDenial) {
    super(denial.message);
    this.name = "OkedToolDeniedError";
    this.toolName = denial.toolName;
    this.tier = denial.tier;
    this.decision = denial.decision;
    this.approvalId = denial.approvalId;
  }
}

function idNote(approvalId: string | null): string {
  return approvalId ? ` (approval ${approvalId})` : "";
}

/** Final sentence for the model. A denial is not a transient tool error. */
export function finalDecision(text: string): string {
  return (
    `${text} The tool did not run. This is a final decision. ` +
    "Do NOT retry the same action. Stop and ask the user what to do instead."
  );
}

export function deniedMessage(toolName: string, description: string, approvalId: string | null): string {
  return finalDecision(
    `OKed: a person denied ${toolName}${idNote(approvalId)}. ${description}.`,
  );
}

export function timeoutMessage(toolName: string, description: string, approvalId: string | null): string {
  return finalDecision(
    `OKed: no one responded in time for ${toolName}${idNote(approvalId)}. The approval timed out. ${description}.`,
  );
}

export function unpairedMessage(toolName: string): string {
  return finalDecision(
    `OKed: no API key is configured, so ${toolName} was denied. ` +
      "Set OKED_API_KEY, or put the key in ~/.oked/config.json. " +
      "Decisions are made in Telegram or on the web dashboard.",
  );
}

export function receiptMessage(toolName: string, problems: string[]): string {
  const why = problems.length ? problems.join(", ") : "invalid";
  return finalDecision(
    `OKed: the approval receipt for ${toolName} did not verify (${why}), so this action is denied.`,
  );
}

export function authMessage(toolName: string): string {
  return finalDecision(
    `OKed: the API key was rejected for ${toolName}. This is a configuration error, not a transient failure.`,
  );
}

export function unreachableMessage(toolName: string, tier: RiskTier, why: string, cause: string): string {
  return finalDecision(
    `OKed: the approval service could not be reached (${cause}), so this ${tier} action ${toolName} was denied (${why}, fail closed).`,
  );
}

export function unexpectedMessage(toolName: string, cause: string): string {
  return finalDecision(`OKed: unexpected error while approving ${toolName} (${cause}). Denied (fail closed).`);
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.replace(/\s+/g, " ").trim();
  return String(err);
}
