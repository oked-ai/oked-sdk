"""Effect-based risk tiers for a tool call.

Unknown tool names are review. A string command or cmd is a shell command.
A path plus a content string is a file write: warning, or review when the
path is a system directory, a secret store, or a shell startup file.

Shell classification follows the same effect model as @oked/sdk. Deletes
outside temp and build-output directories, force-push, disk and process
destruction, publishes, and cloud deletes or applies are high_stakes.
Unrecognized shell commands are safe. This module does not reproduce every
Claude Code MCP and browser rule; those tool names are review.
"""

from __future__ import annotations

import os
import re
from typing import Mapping

from oked.types import RiskTier

_SAFE_TOOLS = frozenset({"Read", "Glob", "Grep", "WebSearch", "TodoRead", "TaskGet", "TaskList"})
_SAFE_ALIASES = frozenset(
    {
        "read",
        "read_file",
        "readfile",
        "view",
        "cat",
        "list",
        "list_files",
        "listfiles",
        "ls",
        "glob",
        "grep",
        "search",
        "search_files",
        "find",
    }
)
_SAFE_SESSION = frozenset(
    {
        "TaskStop",
        "KillShell",
        "TaskOutput",
        "BashOutput",
        "TaskCreate",
        "TaskUpdate",
        "TodoWrite",
        "ToolSearch",
        "Skill",
        "AskUserQuestion",
        "EnterPlanMode",
        "ExitPlanMode",
        "ListAgents",
        "CronList",
        "ScheduleWakeup",
        "LSP",
        "ReportFindings",
        "SendUserFile",
        "PushNotification",
    }
)
_WARNING_SESSION = frozenset({"EnterWorktree", "CronCreate", "CronDelete", "SendMessage", "WebFetch"})

_HIGH_STAKES_COMMANDS = [
    re.compile(r"\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b"),
    re.compile(r"\bgit\s+reset\s+--hard\b"),
    re.compile(r"\bgit\s+clean\s+-f"),
    re.compile(r"\bgit\s+checkout\s+--\s+\."),
    re.compile(r"\bgit\s+restore\s+--staged\s+\."),
    re.compile(r"\bdocker\s+(rm|rmi|system\s+prune)\b"),
    re.compile(r"\bdocker\s+compose\s+down\b"),
    re.compile(r"\bwget\s+.*\|\s*(bash|sh|zsh)\b"),
    re.compile(r"\bcurl\s+.*\|\s*(bash|sh|zsh)\b"),
    re.compile(r"\bnpm\s+publish\b"),
    re.compile(r"\bnpm\s+unpublish\b"),
    re.compile(r"\bnpx\s+.*\s+deploy\b"),
    re.compile(r"\bhimalaya\s+message\s+delete\b"),
    re.compile(r"\bhimalaya\s+folder\s+(delete|expunge|purge)\b"),
    re.compile(r"\bhimalaya\s+account\s+delete\b"),
    re.compile(r">\s*\/dev\/(sd|nvme|hd|disk|mmcblk|vd)\w*"),
]
_HIGH_STAKES_STAGE = [
    re.compile(r"^mkfs(\.\w+)?\b"),
    re.compile(r"^mkswap\b"),
    re.compile(r"^(fdisk|parted|gparted)\b"),
    re.compile(r"^dd\b.*\bof=\/dev\/"),
    re.compile(r"^shred\b"),
    re.compile(r"^truncate\b"),
    re.compile(r"^find\b.*\s-delete\b"),
    re.compile(r"^(shutdown|reboot|halt|poweroff)\b"),
    re.compile(r"^scp\b"),
    re.compile(r"^rsync\b.*(--delete|\s\S+:)"),
    re.compile(r"^git\s+branch\s+(?:-D|--delete)\b"),
    re.compile(r"^git\s+tag\s+(?:-d|--delete)\b"),
    re.compile(r"^git\s+stash\s+(?:drop|clear)\b"),
    re.compile(r"^git\s+push\b.*\s(?:--delete|-d)\b"),
    re.compile(r"^git\s+push\b.*\s\+?:[^\s:]+(?:\s|$)"),
    re.compile(r"^kill\b"),
    re.compile(r"^pkill\b"),
    re.compile(r"^killall\b"),
    re.compile(r"^chmod\s+(?:-\S+\s+)*777\b"),
    re.compile(r"^gh\s+pr\s+merge\b"),
    re.compile(r"^gh\s+(?:repo|release|issue|label|gist|secret|variable|cache|run|ruleset)\s+delete\b"),
    re.compile(r"^gh\s+repo\s+archive\b"),
    re.compile(r"^railway\s+(?:up|deploy|redeploy|down|delete)\b"),
]
_OUTWARD_CURL = [
    re.compile(r"\bcurl\s+.*-X\s*(DELETE|PUT|POST|PATCH)\b", re.IGNORECASE),
    re.compile(r"\bcurl\s+.*--request[\s=]*(DELETE|PUT|POST|PATCH)\b", re.IGNORECASE),
    re.compile(r"\bcurl\b.*\s-d[\s=]"),
    re.compile(r"\bcurl\b.*\s--data(-raw|-binary|-urlencode|-ascii)?[\s=]"),
    re.compile(r"\bcurl\b.*\s-F[\s=]"),
    re.compile(r"\bcurl\b.*\s--form[\s=]"),
    re.compile(r"\bcurl\b.*\s(-T|--upload-file)[\s=]"),
    re.compile(r"\bcurl\b.*\s--json[\s=]"),
]
_CURL_HIGH = [
    re.compile(r"\bcurl\s+.*-X\s*DELETE\b", re.IGNORECASE),
    re.compile(r"\bcurl\s+.*--request[\s=]*DELETE\b", re.IGNORECASE),
    re.compile(r"\bcurl\b.*\s(-T|--upload-file)[\s=]"),
    re.compile(r"\bcurl\b.*\s(?:-d|--data(?:-binary|-ascii|-raw)?|--json)(?:\s+|=)['\"]?@"),
]
_REVIEW_COMMANDS = [
    re.compile(r"^himalaya\s+message\s+(send|reply|forward)\b"),
    re.compile(r"^gh\s+pr\s+(?:close|reopen|comment|review|edit|ready|lock|unlock)\b"),
    re.compile(r"^gh\s+issue\s+(?:create|close|reopen|comment|edit|transfer|lock|unlock|pin|unpin)\b"),
    re.compile(r"^gh\s+release\s+(?:create|edit|upload)\b"),
    re.compile(r"^gh\s+repo\s+(?:create|edit|rename|fork)\b"),
    re.compile(r"^gh\s+(?:secret|variable)\s+set\b"),
    re.compile(r"^gh\s+workflow\s+(?:run|enable|disable)\b"),
]
_WARNING_COMMANDS = [
    re.compile(r"^git\s+add\b"),
    re.compile(r"^git\s+commit\b"),
    re.compile(r"^git\s+checkout\s+-b\b"),
    re.compile(r"^git\s+switch\b"),
    re.compile(r"^git\s+stash\b(?!\s+(?:drop|clear))"),
    re.compile(r"^git\s+push\b"),
    re.compile(r"^gh\s+pr\s+create\b"),
    re.compile(r"^npm\s+(install|ci|i|update|upgrade|rebuild|prune|dedupe)\b"),
    re.compile(r"^(pnpm|yarn)\s+(install|add|ci|up|upgrade)\b"),
]
_DELETE_LEAD = re.compile(r"^(?:(?:sudo|command|exec|builtin|time|nice|xargs|then|do|else)\b\s*(?:-\S+\s+)*)+")
_DELETE_COMMAND = re.compile(r"(?:^|[\n`({]|\$\()\s*(?:rm|rmdir|trash|trash-put)\b")
_EPHEMERAL = re.compile(
    r"^(?:/tmp/|/var/tmp/|/var/folders/|/private/tmp/|/private/var/folders/|"
    r"[A-Za-z]:[\\/](?:Windows[\\/]Temp|Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp)[\\/])",
    re.IGNORECASE,
)
_BUILD_OUTPUT = frozenset({"build", "dist", ".build", "DerivedData", ".next"})
_CLOUD = frozenset(
    {
        "aws",
        "kubectl",
        "helm",
        "terraform",
        "tofu",
        "terragrunt",
        "pulumi",
        "cdk",
        "serverless",
        "sls",
        "gcloud",
        "gsutil",
        "az",
        "doctl",
        "eksctl",
        "vercel",
        "netlify",
        "fly",
        "flyctl",
        "heroku",
        "wrangler",
        "firebase",
        "stripe",
    }
)
_ORDER = {"safe": 0, "warning": 1, "review": 2, "high_stakes": 3}


def _max(left: RiskTier, right: RiskTier) -> RiskTier:
    return left if _ORDER[left] >= _ORDER[right] else right


def _unquote(text: str) -> str:
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


def _split_args(text: str) -> list[str]:
    out: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for char in text:
        if quote:
            if char == quote:
                quote = None
            else:
                current.append(char)
        elif char in {'"', "'"}:
            quote = char
        elif char.isspace():
            if current:
                out.append("".join(current))
                current = []
        else:
            current.append(char)
    if current:
        out.append("".join(current))
    return out


def _split_top_level(command: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(command):
        char = command[index]
        if quote:
            current.append(char)
            if char == quote and command[index - 1 : index] != "\\":
                quote = None
            index += 1
            continue
        if char in {'"', "'"}:
            quote = char
            current.append(char)
            index += 1
            continue
        if command.startswith("&&", index) or command.startswith("||", index):
            parts.append("".join(current))
            current = []
            index += 2
            continue
        if char in "|;":
            parts.append("".join(current))
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def is_sensitive_write_path(file_path: str) -> bool:
    """System dirs, secret stores, shell startup files, and OKed's own config."""
    if not file_path:
        return True
    home = os.path.expanduser("~")
    expanded = file_path
    if expanded == "~" or expanded.startswith("~/"):
        expanded = home + expanded[1:]
    expanded = re.sub(r"^\$\{?HOME\}?(?=/|$)", home, expanded)
    resolved = os.path.abspath(expanded)

    def under(rel: str) -> bool:
        base = os.path.join(home, rel)
        return resolved == base or resolved.startswith(base + os.sep)

    if resolved in {
        os.path.join(home, ".claude", "settings.json"),
        os.path.join(home, ".claude", "settings.local.json"),
    }:
        return True
    for directory in (
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".docker",
        os.path.join(".config", "gcloud"),
    ):
        if under(directory):
            return True
    sensitive_files = {
        ".netrc",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        ".bash_history",
        ".zsh_history",
        ".bashrc",
        ".zshrc",
        ".bash_profile",
        ".zprofile",
        ".profile",
        ".zshenv",
        ".zlogin",
    }
    if os.path.dirname(resolved) == home and os.path.basename(resolved) in sensitive_files:
        return True
    if re.match(r"^/(etc|usr|bin|sbin|boot|sys|proc|opt|Library|System)(/|$)", resolved):
        return True
    if re.match(r"^/private/etc(/|$)", resolved):
        return True
    if re.match(r"^/var(/|$)", resolved) and not re.match(r"^/var/(tmp|folders)(/|$)", resolved):
        return True
    return False


def _ephemeral(path: str) -> bool:
    return bool(path) and _EPHEMERAL.match(path) is not None


def _delete_targets(stage: str) -> list[str] | None:
    match = re.match(r"^(?:sudo\s+)?(?:rm|rmdir|trash|trash-put)\b\s+(.+)$", stage, re.DOTALL)
    if not match:
        return None
    return [
        arg
        for arg in _split_args(match.group(1))
        if not arg.startswith("-") and not re.match(r"^(?:\d|&)?>>?\S+$", arg)
    ]


def _ephemeral_only_deletion(stage: str) -> bool:
    targets = _delete_targets(stage)
    if not targets:
        return False
    return all(_ephemeral(_unquote(target)) for target in targets)


def _build_output_only_deletion(stage: str) -> bool:
    match = re.match(r"^(?:rm|trash|trash-put)\b\s+(.+)$", stage, re.DOTALL)
    if not match:
        return False
    targets = [arg for arg in _split_args(match.group(1)) if not arg.startswith("-")]
    if not targets:
        return False
    for target in targets:
        parts = _unquote(target).replace("./", "", 1) if _unquote(target).startswith("./") else _unquote(target)
        segments = parts.split("/")
        if segments[0] not in _BUILD_OUTPUT or ".." in segments:
            return False
    return True


def _cloud_tier(stage: str) -> RiskTier | None:
    bare = re.sub(r"^sudo\s+", "", stage.strip())
    args = _split_args(bare)
    if not args:
        return None
    tool = args[0].rsplit("/", 1)[-1]
    if tool not in _CLOUD:
        return None
    rest = args[1:]
    if any(item == "--help" or item.startswith("--dry-run") for item in rest):
        return "safe"
    words = [item for item in rest if not item.startswith("-")]
    read_prefixes = (
        "describe",
        "list",
        "get",
        "head",
        "ls",
        "plan",
        "show",
        "status",
        "version",
        "help",
        "logs",
    )
    for word in words:
        head = word.split(":")[-1].split("-")[0]
        if head in {"delete", "destroy", "terminate", "purge", "uninstall", "drain"} or word in {
            "rm",
            "rb",
        }:
            return "high_stakes"
        if head in {"apply", "deploy"} or (
            tool in {"pulumi", "terraform", "tofu", "terragrunt"} and word in {"up", "destroy"}
        ):
            return "high_stakes"
    for word in words:
        head = word.split(":")[-1].split("-")[0]
        if head.startswith(read_prefixes):
            continue
        if head in {
            "create",
            "update",
            "patch",
            "set",
            "put",
            "upload",
            "exec",
            "install",
            "upgrade",
            "start",
            "stop",
            "restart",
            "scale",
            "invoke",
            "post",
            "apply",
        }:
            return "review"
    if tool == "stripe" and words:
        if words[0] in {"post", "delete"}:
            return "high_stakes"
        if (
            len(words) >= 2
            and words[1] not in {"list", "retrieve", "search"}
            and words[0]
            not in {
                "get",
                "listen",
                "logs",
                "login",
                "config",
                "version",
                "trigger",
            }
        ):
            return "high_stakes"
    return "safe"


def _redirect_tier(stage: str) -> RiskTier | None:
    match = re.search(r"(?:^|[^\d])>{1,2}\s*([^\s|&;]+)", stage)
    if not match:
        return None
    target = _unquote(match.group(1))
    if target in {"/dev/null", "/dev/stdout", "/dev/stderr"}:
        return None
    return "review" if is_sensitive_write_path(target) else "warning"


def _classify_stage(stage: str) -> RiskTier:
    stripped = _DELETE_LEAD.sub("", stage).strip()
    if _ephemeral_only_deletion(stripped) or _ephemeral_only_deletion(stage):
        return "warning"
    bare = re.sub(r"^sudo\s+", "", stripped)
    if _build_output_only_deletion(bare):
        return "warning"
    if _DELETE_COMMAND.search(bare) or _DELETE_COMMAND.search(stripped):
        return "high_stakes"
    for pattern in _HIGH_STAKES_STAGE:
        if pattern.search(bare):
            return "high_stakes"
    if any(pattern.search(stage) for pattern in _OUTWARD_CURL):
        if any(pattern.search(stage) for pattern in _CURL_HIGH):
            return "high_stakes"
        return "review"
    cloud = _cloud_tier(bare)
    if cloud is not None and cloud != "safe":
        return cloud
    redirect = _redirect_tier(stage)
    if redirect is not None:
        return redirect
    for pattern in _REVIEW_COMMANDS:
        if pattern.search(bare):
            return "review"
    if bare.startswith("sudo "):
        return "review"
    for pattern in _WARNING_COMMANDS:
        if pattern.search(bare):
            return "warning"
    if cloud == "safe":
        return "safe"
    return "safe"


def classify_shell(command: str) -> RiskTier:
    """Tier of one shell command. Empty is safe."""
    if not command or not command.strip():
        return "safe"
    for pattern in _HIGH_STAKES_COMMANDS:
        if pattern.search(command):
            return "high_stakes"
    stages = _split_top_level(command)
    if len(stages) > 1:
        worst: RiskTier = "safe"
        for stage in stages:
            worst = _max(worst, classify_shell(stage))
        return worst
    return _classify_stage(command.strip())


def _string_field(tool_input: Mapping[str, object], *names: str) -> str | None:
    for name in names:
        value = tool_input.get(name)
        if isinstance(value, str):
            return value
    return None


def classify(tool_name: str, tool_input: Mapping[str, object] | None = None) -> RiskTier:
    """Risk tier for a tool call. Unknown names are review."""
    payload: Mapping[str, object] = tool_input or {}
    if tool_name in _SAFE_TOOLS or tool_name.lower() in _SAFE_ALIASES:
        return "safe"
    if tool_name in _SAFE_SESSION:
        return "safe"
    if tool_name in _WARNING_SESSION:
        return "warning"
    if tool_name in {"Write", "Edit", "NotebookEdit"}:
        return "review" if is_sensitive_write_path(_string_field(payload, "file_path") or "") else "warning"
    if tool_name == "Agent":
        return "safe"
    if tool_name == "Bash" or _string_field(payload, "command", "cmd") is not None:
        return classify_shell(_string_field(payload, "command", "cmd") or "")
    if tool_name.startswith("mcp__"):
        return "review"
    path = _string_field(payload, "file_path", "path")
    content = _string_field(payload, "content", "data", "body")
    if path is not None and content is not None:
        return "review" if is_sensitive_write_path(path) else "warning"
    return "review"
