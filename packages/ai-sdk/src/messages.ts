const STOP =
  "Do NOT retry the same action. Stop and ask the user what to do instead.";

export function idSuffix(id: string | null | undefined): string {
  return id ? ` (approval ${id})` : "";
}

export function deniedMessage(id: string | null): string {
  return `USER DENIED this action via OKed${idSuffix(id)}. This is a final human decision. ${STOP}`;
}

export function timeoutMessage(id: string | null): string {
  return (
    `USER did not respond to this action via OKed${idSuffix(id)}. ` +
    `The approval window expired, so the action was not run. ${STOP}`
  );
}

export function noKeyMessage(): string {
  return (
    "OKed: no API key is configured, so this action was not run. " +
    "Set OKED_API_KEY, or save an apiKey in ~/.oked/config.json. " +
    "Create a key from the dashboard at https://oked.ai/dashboard, " +
    "or run `oked init --key-only` from @oked/claude-code. " +
    STOP
  );
}

export function authMessage(): string {
  return (
    "OKed: invalid API key (configuration error, not a transient failure). " +
    STOP
  );
}

export function receiptMessage(problems: readonly string[]): string {
  const detail = problems.length > 0 ? problems.join(", ") : "invalid";
  return (
    `OKed: the approval receipt did not verify (${detail}), so this action was not run. ` +
    STOP
  );
}

export function pendingMessage(detail: string): string {
  return `${detail} ${STOP}`;
}

export function httpMessage(status: number, detail: string): string {
  const extra = detail ? `: ${detail}` : "";
  return `OKed: backend error HTTP ${status}${extra} (fail-safe deny). ${STOP}`;
}

export function unreachableMessage(tier: string, why: string): string {
  return (
    `OKed backend unreachable. This ${tier} action was not run (${why}, fail-safe). ${STOP}`
  );
}

export function unexpectedMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `OKed: unexpected error (fail-safe deny): ${msg}. ${STOP}`;
}

export function malformedMessage(): string {
  return `OKed: the approval response was malformed, so this action was not run. ${STOP}`;
}

export function classifierMessage(): string {
  return `OKed: the classifier failed, so this action was not run (fail-safe deny). ${STOP}`;
}

export function missingNameMessage(): string {
  return `OKed: the tool call had no name, so it was not run. ${STOP}`;
}

export function approvedMessage(id: string | null): string {
  return `Approved via OKed${idSuffix(id)}`;
}
