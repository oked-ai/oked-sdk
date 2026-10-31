"""Watch mode: let a risky action run and record that it would have paused.

The JSON lines match the TypeScript log, so `oked report` can read either.
A line stores the time, tool name, tier, client, source, and a fixed reason.
It does not store the command, tool arguments, description, working directory,
session id, or API key. Nothing about the action is sent anywhere.
"""

from __future__ import annotations

import json
import os
from typing import Any, Literal

from oked.config import load_oked_config, oked_home

OkedMode = Literal["watch", "enforce"]
WatchReason = Literal[
    "would have paused",
    "would have paused (not paired)",
    "would have paused (saved rule)",
]

_REASONS = {
    "would have paused",
    "would have paused (not paired)",
    "would have paused (saved rule)",
}
_TIERS = {"safe", "warning", "review", "high_stakes"}
_MAX_BYTES = 1_000_000


def parse_mode(value: object) -> OkedMode | None:
    if value == "watch" or value == "enforce":
        return value
    return None


def resolve_mode(explicit: object = None, persisted: object = None) -> OkedMode:
    """Explicit value, then OKED_MODE, then ~/.oked/config.json, then enforce."""
    for candidate in (explicit, os.environ.get("OKED_MODE"), persisted):
        chosen = parse_mode(candidate)
        if chosen:
            return chosen
    if persisted is None:
        chosen = parse_mode(load_oked_config().mode)
        if chosen:
            return chosen
    return "enforce"


def effective_mode(explicit: object = None, client_mode: object = None) -> OkedMode:
    chosen = parse_mode(explicit)
    if chosen:
        return chosen
    from_client = parse_mode(client_mode)
    if from_client:
        return from_client
    return resolve_mode()


def watch_log_path() -> str:
    override = os.environ.get("OKED_WATCH_LOG")
    if override:
        return override
    return os.path.join(oked_home(), "watch.log")


def _one_line(value: object, limit: int, fallback: str) -> str:
    raw = value if isinstance(value, str) else ""
    line = " ".join(raw.split()).strip()
    if not line:
        return fallback
    return line[:limit]


def record_would_have_paused(
    *,
    tool: str,
    tier: str,
    client: str,
    source: str,
    reason: str,
    path: str | None = None,
) -> None:
    """Append one line. A log problem never changes the decision."""
    target = path or watch_log_path()
    row = {
        "ts": _iso_now(),
        "outcome": "would_have_paused",
        "tool": _one_line(tool, 120, "unknown"),
        "tier": tier if tier in _TIERS else "unknown",
        "client": _one_line(client, 80, "unknown"),
        "source": _one_line(source, 40, "unknown"),
        "reason": reason if reason in _REASONS else "would have paused",
    }
    try:
        directory = os.path.dirname(target)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        try:
            if os.path.getsize(target) > _MAX_BYTES:
                os.replace(target, target + ".1")
        except OSError:
            pass
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    except OSError:
        return


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_watch_log(path: str | None = None) -> tuple[list[dict[str, Any]], int]:
    target = path or watch_log_path()
    try:
        with open(target, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return [], 0
    entries: list[dict[str, Any]] = []
    unparsable = 0
    for line in text.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            parsed = json.loads(trimmed)
        except json.JSONDecodeError:
            unparsable += 1
            continue
        if not isinstance(parsed, dict) or parsed.get("outcome") != "would_have_paused":
            unparsable += 1
            continue
        if parsed.get("reason") not in _REASONS:
            unparsable += 1
            continue
        entries.append(parsed)
    return entries, unparsable
