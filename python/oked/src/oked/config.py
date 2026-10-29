"""~/.oked/config.json. Same file the Node integrations write."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any


def oked_home() -> str:
    return os.path.join(os.path.expanduser("~"), ".oked")


def config_path() -> str:
    return os.path.join(oked_home(), "config.json")


def rules_cache_path() -> str:
    return os.path.join(oked_home(), "rules-cache.json")


def heartbeat_path() -> str:
    return os.path.join(oked_home(), "heartbeat.json")


@dataclass
class PersistedConfig:
    api_key: str | None = None
    backend_url: str | None = None
    strict_fail_closed: bool | None = None
    rules_cache_ttl_seconds: float | None = None
    heartbeat_interval_seconds: float | None = None
    require_receipt: bool | None = None
    receipt_keys_url: str | None = None


def load_oked_config() -> PersistedConfig:
    """Read ~/.oked/config.json. Any error yields an empty config."""
    try:
        with open(config_path(), encoding="utf-8") as handle:
            parsed: Any = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return PersistedConfig()
    if not isinstance(parsed, dict):
        return PersistedConfig()
    out = PersistedConfig()
    api_key = parsed.get("apiKey")
    if isinstance(api_key, str) and api_key:
        out.api_key = api_key
    backend = parsed.get("backendUrl")
    if isinstance(backend, str) and backend:
        out.backend_url = backend
    strict = parsed.get("strictFailClosed")
    if isinstance(strict, bool):
        out.strict_fail_closed = strict
    rules_ttl = parsed.get("rulesCacheTtlSeconds")
    if isinstance(rules_ttl, (int, float)) and not isinstance(rules_ttl, bool) and rules_ttl >= 0:
        out.rules_cache_ttl_seconds = float(rules_ttl)
    heartbeat = parsed.get("heartbeatIntervalSeconds")
    if isinstance(heartbeat, (int, float)) and not isinstance(heartbeat, bool) and heartbeat >= 0:
        out.heartbeat_interval_seconds = float(heartbeat)
    require = parsed.get("requireReceipt")
    if isinstance(require, bool):
        out.require_receipt = require
    keys_url = parsed.get("receiptKeysUrl")
    if isinstance(keys_url, str) and keys_url:
        out.receipt_keys_url = keys_url
    return out
