/**
 * Typed errors thrown by OKedClient.approve() so callers can tell *why* a
 * request failed and apply the right policy:
 *
 *  - OKedAuthError            -> bad/missing API key. Always deny. Never an
 *                                outage, so degraded-mode does NOT apply.
 *  - OKedBackendUnreachableError -> connect failure, timeout, or 5xx. This is
 *                                the outage case degradedDecision() handles.
 *
 * An explicit user *deny* is NOT an error: approve() returns normally with
 * { approved: false, decision: "denied" } and must always be honored.
 */

export class OKedAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "OKedAuthError";
    this.status = status;
  }
}

export class OKedBackendUnreachableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OKedBackendUnreachableError";
    this.cause = cause;
  }
}
