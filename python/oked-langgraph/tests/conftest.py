"""Keep LangGraph tests off a real API key and the real home directory."""

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
        "OKED_MODE",
        "OKED_WATCH_LOG",
        "OKED_BACKEND_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    return home
