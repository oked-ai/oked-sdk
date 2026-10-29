"""Rules and the tiers the LangGraph gate depends on."""

from __future__ import annotations

from oked import apply_rules, classify


def test_apply_rules_first_match_wins() -> None:
    rules = [
        {
            "id": "r1",
            "match": {"kind": {"op": "equals", "value": "ssh_remote"}},
            "action": "auto_approve",
        },
        {"id": "r2", "match": {"title": {"op": "contains", "value": "SSH"}}, "action": "auto_deny"},
    ]
    decision = apply_rules(
        {"tier": "high_stakes", "fields": {"Title": "SSH to host", "Kind": "ssh_remote"}},
        rules,
        cwd="/work",
    )
    assert decision.outcome == "auto_approve"
    assert decision.applied_rule_id == "r1"


def test_set_tier_and_invalid_regex() -> None:
    raised = apply_rules(
        {"tier": "warning", "fields": {"Target": "prod-db"}},
        [
            {
                "id": "r",
                "match": {"target": {"op": "contains", "value": "prod"}},
                "action": "set_tier",
                "tier": "high_stakes",
            }
        ],
        cwd="",
    )
    assert raised.outcome == "ask"
    assert raised.tier == "high_stakes"
    assert raised.tier_overridden_from == "warning"
    missed = apply_rules(
        {"tier": "review", "fields": {"Title": "hello"}},
        [{"id": "bad", "match": {"title": {"op": "matches", "value": "("}}, "action": "auto_deny"}],
        cwd="",
    )
    assert missed.applied_rule_id is None


def test_classify_matches_the_langgraph_cases() -> None:
    assert classify("list_files", {}) == "safe"
    assert classify("write_note", {"path": "/tmp/note.txt", "content": "hello"}) == "warning"
    assert classify("write_note", {"path": "/etc/hosts", "content": "x"}) == "review"
    assert classify("shell", {"command": "rm -rf ./src"}) == "high_stakes"
    assert classify("send_invoice", {"amount": 1}) == "review"
    assert classify("shell", {"command": "git push --force origin main"}) == "high_stakes"
