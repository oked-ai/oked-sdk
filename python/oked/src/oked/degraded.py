"""What to do when the OKed backend cannot be reached."""

from __future__ import annotations

from typing import Literal

from oked.types import RiskTier

# Higher means more dangerous.
TIER_ORDER: dict[RiskTier, int] = {
    "safe": 0,
    "warning": 1,
    "review": 2,
    "high_stakes": 3,
}


def degraded_decision(tier: RiskTier, *, strict_fail_closed: bool = False) -> Literal["allow", "deny"]:
    """Outage policy. An explicit denial is never passed here.

    strict_fail_closed denies every tier. Otherwise only high_stakes is
    denied, so one outage does not stop every lower-tier action. An
    irreversible action still does not run unsupervised.
    """
    if strict_fail_closed:
        return "deny"
    return "deny" if tier == "high_stakes" else "allow"
