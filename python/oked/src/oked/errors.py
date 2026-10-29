"""Errors from OkedClient.approve.

An explicit denial is not an error. approve() returns approved=False.

- OkedAuthError: bad or missing API key. Always deny. Not an outage.
- OkedBackendUnreachableError: connect failure, HTTP 5xx, a hosting-platform
  page, or a reply that is not JSON. Callers apply degraded_decision().
  A request the backend accepted and then held past the timer is not an
  outage: approve() returns decision "timeout".
- OkedTooManyPendingError: HTTP 429. Always deny. Not an outage.
- OkedHttpError: any other HTTP error from the backend. Always deny.
- OkedReceiptError: the receipt does not verify, or an approval arrived
  with none while require_receipt is on. Always deny. Not an outage.
"""

from __future__ import annotations


class OkedError(Exception):
    """Base class for errors raised by the OKed client."""


class OkedAuthError(OkedError):
    def __init__(self, message: str, status: int = 401) -> None:
        super().__init__(message)
        self.status = status


class OkedBackendUnreachableError(OkedError):
    def __init__(
        self, message: str, cause: BaseException | None = None, status: int | None = None
    ) -> None:
        super().__init__(message)
        self.cause = cause
        self.status = status


class OkedTooManyPendingError(OkedError):
    status = 429

    def __init__(self, detail: str = "") -> None:
        extra = f" (HTTP 429: {detail})" if detail else " (HTTP 429)"
        super().__init__(
            "OKed: too many approvals are waiting for your decision. "
            "Approve or deny them in Telegram or on the dashboard, then try again." + extra
        )
        self.detail = detail


class OkedHttpError(OkedError):
    def __init__(self, status: int, detail: str) -> None:
        suffix = f": {detail}" if detail else ""
        super().__init__(f"OKed backend error HTTP {status}{suffix}")
        self.status = status
        self.detail = detail


class OkedReceiptError(OkedError):
    def __init__(self, reason: str, problems: list[str]) -> None:
        super().__init__(f"OKed receipt not valid: {reason}")
        self.problems = problems
