"""User rules. First match wins. No I/O."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from oked.types import RiskTier

FieldOpName = Literal["equals", "contains", "starts_with", "matches", "is_empty"]
RuleAction = Literal["auto_approve", "auto_deny", "set_tier"]
RuleOutcome = Literal["ask", "auto_approve", "auto_deny"]

_FIELD_KEY = {
    "kind": "Kind",
    "title": "Title",
    "target": "Target",
    "body": "Body",
}


@dataclass
class Rule:
    id: str
    match: dict[str, Any]
    action: str
    tier: str | None = None


@dataclass
class RuleDecision:
    outcome: RuleOutcome
    tier: RiskTier
    applied_rule_id: str | None = None
    tier_overridden_from: RiskTier | None = None


def _as_rule(rule: Rule | Mapping[str, Any]) -> Rule:
    if isinstance(rule, Rule):
        return rule
    match = rule.get("match")
    return Rule(
        id=str(rule.get("id", "")),
        match=dict(match) if isinstance(match, Mapping) else {},
        action=str(rule.get("action", "")),
        tier=rule.get("tier") if isinstance(rule.get("tier"), str) else None,
    )


def _eval_op(op: object, value: str | None) -> bool:
    if not isinstance(op, Mapping):
        return False
    name = op.get("op")
    expected = op.get("value")
    if name == "is_empty":
        return not value
    if not isinstance(expected, str):
        return False
    if name == "equals":
        return value == expected
    if name == "contains":
        return value is not None and expected in value
    if name == "starts_with":
        return value is not None and value.startswith(expected)
    if name == "matches":
        if value is None:
            return False
        try:
            return re.search(expected, value) is not None
        except re.error:
            return False
    return False


def _rule_matches(rule: Rule, fields: Mapping[str, str], cwd: str) -> bool:
    match = rule.match
    for name, key in _FIELD_KEY.items():
        if name in match and not _eval_op(match.get(name), fields.get(key)):
            return False
    if "cwd" in match and not _eval_op(match.get("cwd"), cwd):
        return False
    return True


def apply_rules(
    classified: Mapping[str, Any],
    rules: list[Rule | Mapping[str, Any]],
    *,
    cwd: str,
) -> RuleDecision:
    """First matching rule wins. No match keeps the classifier tier and asks."""
    tier = classified.get("tier", "review")
    if tier not in {"safe", "warning", "review", "high_stakes"}:
        tier = "review"
    fields = classified.get("fields")
    field_map = dict(fields) if isinstance(fields, Mapping) else {}
    for raw in rules:
        rule = _as_rule(raw)
        if not _rule_matches(rule, field_map, cwd):
            continue
        if rule.action == "auto_approve":
            return RuleDecision(outcome="auto_approve", tier=tier, applied_rule_id=rule.id)
        if rule.action == "auto_deny":
            return RuleDecision(outcome="auto_deny", tier=tier, applied_rule_id=rule.id)
        if rule.action == "set_tier":
            if rule.tier not in {"safe", "warning", "review", "high_stakes"}:
                continue
            return RuleDecision(
                outcome="ask",
                tier=rule.tier,  # type: ignore[arg-type]
                applied_rule_id=rule.id,
                tier_overridden_from=tier if rule.tier != tier else None,
            )
    return RuleDecision(outcome="ask", tier=tier)
