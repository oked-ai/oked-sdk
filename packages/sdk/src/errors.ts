/**
 * Typed errors thrown by OKedClient.approve() so callers can tell *why* a
 * request failed and apply the right policy:
 *
 *  - OKedAuthError            -> bad/missing API key. Always deny. Never an
 *                                outage, so degraded-mode does NOT apply.
 *  - OKedBackendUnreachableError -> connect failure, 5xx, a hosting-platform
 *                                reply instead of the backend (Railway
 *                                "Application not found"), or any reply that
 *                                is not JSON. This is the outage case
 *                                degradedDecision() handles. A request the
 *                                backend accepted and then held past a timer
 *                                is NOT an outage: approve() returns
 *                                { decision: "timeout" } for it.
 *
 *  - OKedTooManyPendingError  -> HTTP 429: too many approvals already wait for
 *                                a decision. Always deny, with a message that
 *                                says what to do. Never an outage.
 *
 *  - OKedHttpError            -> any other HTTP error from the backend. Always
 *                                deny. Carries the status and a short detail.
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
  /** The HTTP status, when a reply came back at all. */
  readonly status?: number;
  constructor(message: string, cause?: unknown, status?: number) {
    super(message);
    this.name = "OKedBackendUnreachableError";
    this.cause = cause;
    this.status = status;
  }
}

export class OKedTooManyPendingError extends Error {
  readonly status = 429;
  constructor(detail = "") {
    super(
      "OKed: too many approvals are waiting for your decision. " +
        "Approve or deny them in Telegram or on the dashboard, then try again." +
        (detail ? ` (HTTP 429: ${detail})` : " (HTTP 429)"),
    );
    this.name = "OKedTooManyPendingError";
  }
}

export class OKedHttpError extends Error {
  readonly status: number;
  /** A short, one-line part of the reply body. */
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`OKed backend error HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "OKedHttpError";
    this.status = status;
    this.detail = detail;
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
