"""Watch mode resolution and the local log."""

from __future__ import annotations

import json

from oked import OkedClient, resolve_mode
from oked.watch import read_watch_log, record_would_have_paused


def test_mode_precedence(monkeypatch, tmp_path):
    home = tmp_path / "home"
    monkeypatch.delenv("OKED_MODE", raising=False)
    assert resolve_mode() == "enforce"
    assert OkedClient(api_key="ok_test").mode == "enforce"

    config = home / ".oked"
    config.mkdir()
    (config / "config.json").write_text(json.dumps({"mode": "watch", "apiKey": "ok_file"}), encoding="utf-8")
    assert resolve_mode() == "watch"
    assert OkedClient(api_key="ok_test").mode == "watch"
    monkeypatch.setenv("OKED_MODE", "enforce")
    assert resolve_mode() == "enforce"
    assert resolve_mode("watch") == "watch"
    assert OkedClient(api_key="ok_test", mode="watch").mode == "watch"


def test_watch_log_omits_the_command(monkeypatch, tmp_path):
    path = tmp_path / "watch.log"
    monkeypatch.setenv("OKED_WATCH_LOG", str(path))
    record_would_have_paused(
        tool="Bash",
        tier="high_stakes",
        client="oked-test",
        source="sdk",
        reason="would have paused",
    )
    text = path.read_text(encoding="utf-8")
    assert "rm -rf" not in text
    assert "SECRET" not in text
    line = json.loads(text)
    assert line["outcome"] == "would_have_paused"
    assert line["tool"] == "Bash"
    assert set(line) == {"ts", "outcome", "tool", "tier", "client", "source", "reason"}
    entries, bad = read_watch_log(str(path))
    assert len(entries) == 1
    assert bad == 0
