"""Keep tests off the real home directory and a real API key."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolate_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    for name in (
        "OKED_API_KEY",
        "OKED_STRICT_FAIL_CLOSED",
        "OKED_REQUIRE_RECEIPT",
        "OKED_MIN_TIER",
        "OKED_BACKEND_URL",
        "OKED_RECEIPT_KEYS_URL",
        "OKED_RULES_CACHE_TTL",
        "OKED_HEARTBEAT_INTERVAL",
    ):
        monkeypatch.delenv(name, raising=False)
    return home
