"""Public request and response types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

RiskTier = Literal["safe", "warning", "review", "high_stakes"]
Decision = Literal["approved", "denied", "timeout"]

TIERS: frozenset[str] = frozenset({"safe", "warning", "review", "high_stakes"})


def is_tier(value: object) -> bool:
    return isinstance(value, str) and value in TIERS


@dataclass
class ApprovalRequest:
    """One action to show a person.

    The same fields are accepted as a dict with these keys.
    """

    action: str
    description: str
    tier: RiskTier
    fields: dict[str, str] | None = None
    tool_input: Any = None
    session_id: str | None = None
    cwd: str | None = None


@dataclass
class ApprovalResponse:
    """The decision. approved is true only when decision is "approved"."""

    approved: bool
    approval_id: str | None
    decision: str
    receipt: dict[str, Any] | None = field(default=None)
