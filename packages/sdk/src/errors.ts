/**
 * Typed errors thrown by OKedClient.approve() so callers can tell *why* a
 * request failed and apply the right policy:
 *
 *  - OKedAuthError            -> bad/missing API key. Always deny. Never an
 *                                outage, so degraded-mode does NOT apply.
 *  - OKedBackendUnreachableError -> connect failure or 5xx. This is the
 *                                outage case degradedDecision() handles. A
 *                                request the backend accepted and then held
 *                                past a timer is NOT an outage: approve()
 *                                returns { decision: "timeout" } for it.
 *
 *  - OKedReceiptError         -> the decision came with a receipt that does not
 *                                verify (or with none, when requireReceipt is
 *                                on). Always deny: a decision we cannot prove
 *                                is not a decision. Never an outage.
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

export class OKedReceiptError extends Error {
  /** e.g. ["bad_signature"], ["subject_mismatch"], ["missing"] */
  readonly problems: string[];
  constructor(reason: string, problems: string[]) {
    super(`OKed receipt not valid: ${reason}`);
    this.name = "OKedReceiptError";
    this.problems = problems;
  }
}
