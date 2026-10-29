"""Short descriptions for an approval card.

Single-line consumers get the title, plus the target when there is one.
fields use the Title, Target, Body, and Kind keys the rules engine matches.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Mapping

_PR_LINK = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$")


@dataclass
class Rendered:
    title: str
    kind: str
    target: str | None = None
    body: str | None = None


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _fallback(tool_name: str, tool_input: Mapping[str, object]) -> Rendered:
    if not tool_input:
        return Rendered(title=tool_name, kind="unknown_tool")
    lines: list[str] = []
    for key, value in tool_input.items():
        if isinstance(value, str):
            shown = _truncate(value, 60)
        else:
            try:
                shown = _truncate(json.dumps(value), 60)
            except TypeError:
                shown = _truncate(str(value), 60)
        lines.append(f"{key}: {shown}")
    return Rendered(title=tool_name, kind="unknown_tool", body="\n".join(lines))


def _shell(command: str) -> Rendered:
    text = command.strip()
    delete = re.search(r"(?:^|[\n`({]|\$\()\s*(rm|trash|trash-put)\b\s+(.+)$", text)
    if delete:
        recursive = re.search(r"\s-(?:rf|fr|r)\b", text) is not None
        target = delete.group(2).strip().split()[0] if delete.group(2).strip() else None
        title = "Delete file recursively" if recursive else "Delete file"
        return Rendered(title=title, kind="file_delete", target=target, body=text if len(text) > 50 else None)
    return Rendered(title="Run command", kind="unknown_bash", body=text or None)


def _write(path: str, content: str) -> Rendered:
    body = content if len(content) <= 200 else content[:197] + "..."
    return Rendered(title="Write file", kind="file_create", target=path, body=body or None)


def _summarize(tool_name: str, tool_input: Mapping[str, object]) -> Rendered:
    if tool_name == "Bash" or isinstance(tool_input.get("command") or tool_input.get("cmd"), str):
        command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else tool_input.get("cmd")
        return _shell(command if isinstance(command, str) else "")
    path = tool_input.get("file_path") if isinstance(tool_input.get("file_path"), str) else tool_input.get("path")
    content = None
    for key in ("content", "data", "body"):
        if isinstance(tool_input.get(key), str):
            content = tool_input.get(key)
            break
    if isinstance(path, str) and isinstance(content, str):
        return _write(path, content)
    return _fallback(tool_name, tool_input)


def describe(tool_name: str, tool_input: Mapping[str, object] | None = None, *, cwd: str | None = None) -> str:
    """One line for logs. cwd is accepted so callers can pass the same context."""
    del cwd
    rendered = _summarize(tool_name, tool_input or {})
    if rendered.target:
        if rendered.title == "Delete file recursively":
            return f"Delete {rendered.target} recursively"
        return f"{rendered.title} {rendered.target}"
    return rendered.title


def describe_fields(
    tool_name: str,
    tool_input: Mapping[str, object] | None = None,
    *,
    cwd: str | None = None,
) -> dict[str, str]:
    """Card fields. Title and Kind are always set."""
    del cwd
    rendered = _summarize(tool_name, tool_input or {})
    fields = {"Title": rendered.title, "Kind": rendered.kind}
    if rendered.target:
        fields["Target"] = rendered.target
    if rendered.body:
        fields["Body"] = rendered.body
    return fields


def lookup_pr_title(fields: Mapping[str, str] | None, timeout_ms: int = 3000) -> str | None:
    """PR title from `gh`, when the card links to a pull request and has no quoted title.

    Returns None when gh is missing, not signed in, or slower than timeout_ms.
    """
    if not fields:
        return None
    link = fields.get("Link")
    title = fields.get("Title") or ""
    if not isinstance(link, str) or _PR_LINK.match(link) is None or '"' in title:
        return None
    try:
        completed = subprocess.run(
            ["gh", "pr", "view", link, "--json", "title", "--jq", ".title"],
            timeout=max(timeout_ms, 1) / 1000,
            capture_output=True,
            text=True,
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    line = completed.stdout.strip().split("\n")[0] if completed.stdout.strip() else ""
    return line or None
