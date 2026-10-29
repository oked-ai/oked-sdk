"""Decide whether one LangChain tool call may run.

The wait is OkedClient.approve(), the same call the other integrations use.
LangGraph's interrupt() pauses until the process that started the graph
resumes it. The person who decides here is on Telegram or the web dashboard,
and approve() already waits for them. Gating before the tool body needs no
checkpointer, and a denial cannot be skipped by resuming the graph.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable, Mapping, MutableMapping, Sequence, TypeGuard, cast

from oked import (
    TIER_ORDER,
    OkedAuthError,
    OkedBackendUnreachableError,
    OkedClient,
    OkedHttpError,
    OkedReceiptError,
    OkedTooManyPendingError,
    apply_rules,
    classify,
    degraded_decision,
    describe,
    describe_fields,
    lookup_pr_title,
)
from oked.types import RiskTier, is_tier

__version__ = "0.6.21"
_APPROVAL_TIERS = frozenset({"review", "high_stakes"})
_WRAPPED = "_oked_langgraph_wrapped"
CLIENT_ID = f"oked-langgraph-py@{__version__}"


def _log_default(message: str) -> None:
    sys.stderr.write(f"[OKed] {message}\n")


def _blocked(lead: str) -> str:
    return f"{lead} This action was not run. Do NOT retry the same action. Stop and ask the user what to do instead."


def _error_text(err: BaseException) -> str:
    return f"{type(err).__name__}: {err}"


def _is_record(value: object) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def tool_input_record(tool_input: object) -> dict[str, Any]:
    """Arguments the model sent, whether invoke got a tool call or raw input."""
    if _is_record(tool_input) and tool_input.get("type") == "tool_call" and "args" in tool_input:
        args = tool_input.get("args")
        if isinstance(args, dict):
            return args
        if isinstance(args, str):
            return {"input": args}
        return {"input": args}
    if isinstance(tool_input, dict):
        return tool_input
    if isinstance(tool_input, str):
        return {"input": tool_input}
    return {"input": tool_input}


def _resolve_min_tier(options: Mapping[str, Any]) -> RiskTier:
    chosen = options.get("min_tier")
    if is_tier(chosen):
        return chosen  # type: ignore[return-value]
    env = os.environ.get("OKED_MIN_TIER")
    if is_tier(env):
        return env  # type: ignore[return-value]
    return "review"


def _name_list(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, (list, tuple)):
        return tuple(item for item in value if isinstance(item, str))
    return ()


def _resolve_tier(tool_name: str, tool_input: Mapping[str, Any], options: Mapping[str, Any]) -> RiskTier:
    if tool_name in _name_list(options.get("always_allow")):
        return "safe"
    if tool_name in _name_list(options.get("always_approve")):
        return "high_stakes"
    override = options.get("tier")
    if is_tier(override):
        return override  # type: ignore[return-value]
    return classify(tool_name, tool_input)


def _session_id(options: Mapping[str, Any]) -> str | None:
    explicit = options.get("session_id")
    if isinstance(explicit, str) and explicit:
        return explicit
    config = options.get("config")
    if not isinstance(config, dict):
        return None
    configurable = config.get("configurable")
    if not isinstance(configurable, dict):
        return None
    thread_id = configurable.get("thread_id")
    if isinstance(thread_id, str) and thread_id:
        return thread_id
    session_id = configurable.get("session_id")
    if isinstance(session_id, str) and session_id:
        return session_id
    return None


def _summary(tool_name: str, tool_input: Mapping[str, Any]) -> str:
    for key in ("file_path", "path", "command", "cmd"):
        value = tool_input.get(key)
        if isinstance(value, str):
            return value
    return tool_name


def create_oked_client(
    *,
    api_key: str | None = None,
    timeout_ms: int | None = None,
    strict_fail_closed: bool | None = None,
) -> OkedClient:
    """Client used when the caller did not pass one.

    source is "langgraph", which is part of the receipt subject. client is
    oked-langgraph-py plus this package version.
    """
    kwargs: dict[str, Any] = {"client": CLIENT_ID, "source": "langgraph"}
    if api_key is not None:
        kwargs["api_key"] = api_key
    if timeout_ms is not None:
        kwargs["timeout"] = timeout_ms
    if strict_fail_closed is not None:
        kwargs["strict_fail_closed"] = strict_fail_closed
    return OkedClient(**kwargs)


def _rules_want_backend(client: Any, tier: RiskTier, fields: Mapping[str, str] | None, cwd: str) -> bool:
    if not getattr(client, "api_key", ""):
        return False
    try:
        rules = client.get_rules()
    except Exception:
        return False
    if not rules:
        return False
    try:
        decision = apply_rules({"tier": tier, "fields": dict(fields or {})}, rules, cwd=cwd)
    except Exception:
        return False
    return bool(decision.applied_rule_id)


def gate_tool_call(tool_name: str, tool_input: Mapping[str, Any] | None = None, **options: Any) -> dict[str, Any]:
    """Classify one call and, when the tier needs a person, wait.

    run is false when the tool body must not run. message is for the model.
    Safe and warning calls run unless a cached user rule matches. No API key
    denies, because LangGraph would otherwise run the tool. A denial, a
    timeout, a bad receipt, a bad key, and any unexpected error deny. An
    unreachable backend follows degraded_decision: high_stakes denies, and
    lower tiers may run unless OKED_STRICT_FAIL_CLOSED is set.
    """
    payload = dict(tool_input or {})
    log: Callable[[str], None] = options.get("log") or _log_default
    client = options.get("client")
    if client is None:
        client = create_oked_client(
            api_key=options.get("api_key"),
            timeout_ms=options.get("timeout_ms"),
            strict_fail_closed=options.get("strict_fail_closed"),
        )
    cwd = options.get("cwd") or os.getcwd()
    if getattr(client, "api_key", ""):
        try:
            client.heartbeat()
        except Exception:
            pass
    try:
        tier = _resolve_tier(tool_name, payload, options)
    except Exception as err:
        log(f"classifier error on {tool_name}: {_error_text(err)}")
        return {
            "run": False,
            "tier": "review",
            "message": _blocked(f"OKed: could not classify {tool_name} ({_error_text(err)})."),
        }
    min_tier = _resolve_min_tier(options)
    needs_approval = tier in _APPROVAL_TIERS and TIER_ORDER[tier] >= TIER_ORDER[min_tier]
    fields = describe_fields(tool_name, payload, cwd=cwd)
    if not needs_approval:
        if not _rules_want_backend(client, tier, fields, cwd):
            if tier == "warning":
                log(f"WARNING {tool_name} {_summary(tool_name, payload)} - allowed (inside project)")
            return {"run": True, "tier": tier}
    if not getattr(client, "api_key", ""):
        log(f"no API key - denying {tool_name}")
        return {
            "run": False,
            "tier": tier,
            "message": _blocked(
                f"OKed: no API key is configured for {tool_name}. "
                "Set OKED_API_KEY, or put an apiKey in ~/.oked/config.json."
            ),
        }
    try:
        pr_title = lookup_pr_title(fields)
        if pr_title:
            fields = describe_fields(tool_name, payload, cwd=cwd)
        description = describe(tool_name, payload, cwd=cwd)
        log(f'{tool_name}: "{description}" - {tier}')
        log("Requesting approval... (Telegram or the web dashboard)")
        result = client.approve(
            {
                "action": tool_name,
                "description": description,
                "tier": tier,
                "fields": fields,
                "tool_input": payload,
                "session_id": _session_id(options),
                "cwd": cwd,
            }
        )
        if result.approved:
            log(f"Approved ({result.approval_id})")
            return {"run": True, "tier": tier, "decision": "approved", "approval_id": result.approval_id}
        if result.decision == "timeout":
            log(f"No decision in time ({result.approval_id})" if result.approval_id else "No decision in time")
            note = f" (approval {result.approval_id})" if result.approval_id else ""
            return {
                "run": False,
                "tier": tier,
                "decision": "timeout",
                "approval_id": result.approval_id,
                "message": _blocked(
                    f"USER did not respond to {tool_name} via OKed{note}. The approval window expired."
                ),
            }
        note = f" (approval {result.approval_id})" if result.approval_id else ""
        log(f"Denied ({result.approval_id})")
        return {
            "run": False,
            "tier": tier,
            "decision": "denied",
            "approval_id": result.approval_id,
            "message": _blocked(f"USER DENIED {tool_name} via OKed{note}. This is a final human decision."),
        }
    except OkedReceiptError as err:
        log(f"Approval receipt did not verify ({', '.join(err.problems)}) - action denied")
        return {
            "run": False,
            "tier": tier,
            "message": _blocked(
                f"OKed: the approval receipt for {tool_name} did not verify ({', '.join(err.problems)})."
            ),
        }
    except OkedAuthError as err:
        log(f"Invalid API key (HTTP {err.status}) - action denied")
        return {
            "run": False,
            "tier": tier,
            "message": _blocked(
                f"OKed: invalid API key for {tool_name} (HTTP {err.status}). "
                "This is a configuration error, not a transient failure."
            ),
        }
    except OkedTooManyPendingError as err:
        log("Too many pending approvals (HTTP 429) - action denied")
        return {"run": False, "tier": tier, "message": _blocked(str(err))}
    except OkedHttpError as err:
        log(f"Backend error HTTP {err.status} - action denied (fail-safe)")
        detail = f": {err.detail}" if err.detail else ""
        return {
            "run": False,
            "tier": tier,
            "message": _blocked(f"OKed: backend error HTTP {err.status}{detail} (fail-safe)."),
        }
    except OkedBackendUnreachableError:
        decision = degraded_decision(tier, strict_fail_closed=bool(getattr(client, "strict_fail_closed", False)))
        if decision == "allow":
            log(f"Backend unreachable - {tool_name} ({tier}) allowed (degraded; non-high-stakes)")
            return {"run": True, "tier": tier, "degraded": True}
        why = "strict fail-closed" if getattr(client, "strict_fail_closed", False) else "high-stakes"
        log(f"Backend unreachable - {tool_name} ({tier}) denied ({why}, fail-safe)")
        return {
            "run": False,
            "tier": tier,
            "message": _blocked(f"OKed backend unreachable. This {tier} action is denied ({why}, fail-safe)."),
        }
    except Exception as err:
        log(f"Unexpected error ({_error_text(err)}) - action denied (fail-safe)")
        return {
            "run": False,
            "tier": tier,
            "message": _blocked(f"OKed: unexpected error (fail-safe) for {tool_name}: {_error_text(err)}."),
        }


async def gate_tool_call_async(
    tool_name: str,
    tool_input: Mapping[str, Any] | None = None,
    **options: Any,
) -> dict[str, Any]:
    """Async gate. The same decision as gate_tool_call, off the event loop."""
    import asyncio

    return await asyncio.to_thread(lambda: gate_tool_call(tool_name, tool_input, **options))


def _denial_result(tool_name: str, tool_input: object, message: str) -> Any:
    if not (
        _is_record(tool_input) and tool_input.get("type") == "tool_call" and isinstance(tool_input.get("name"), str)
    ):
        return message
    from langchain_core.messages import ToolMessage

    call_id = tool_input.get("id")
    return ToolMessage(
        content=message,
        name=tool_name,
        tool_call_id=call_id if isinstance(call_id, str) else "",
        status="error",
    )


def _ensure_client(options: MutableMapping[str, Any]) -> dict[str, Any]:
    copied = dict(options)
    if copied.get("client") is None:
        copied["client"] = create_oked_client(
            api_key=copied.get("api_key"),
            timeout_ms=copied.get("timeout_ms"),
            strict_fail_closed=copied.get("strict_fail_closed"),
        )
    return copied


def _invoke_gated(
    tool: Any, options: Mapping[str, Any], tool_input: object, config: object, kwargs: Mapping[str, Any]
) -> Any:
    call_options = dict(options)
    if config is not None:
        call_options["config"] = config
    gate = gate_tool_call(tool.name, tool_input_record(tool_input), **call_options)
    if not gate["run"]:
        return _denial_result(tool.name, tool_input, gate.get("message") or "OKed: this action was not run.")
    invoke = tool.invoke
    if kwargs:
        return invoke(tool_input, config, **kwargs)
    return invoke(tool_input, config)


def with_oked_approval(tool: Any, **options: Any) -> Any:
    """Wrap one tool. name, description, and args schema stay the same.

    invoke and ainvoke wait when the tier requires a person. Pass the result
    to ToolNode or create_react_agent. A denial does not call the tool.
    """
    if tool is None or not isinstance(tool, object):
        raise TypeError("OKed: with_oked_approval expected a LangChain tool")
    if getattr(tool, _WRAPPED, False) is True:
        return tool
    name = getattr(tool, "name", None)
    if not isinstance(name, str) or not name:
        raise TypeError("OKed: with_oked_approval expected a tool with a name")
    if not callable(getattr(tool, "invoke", None)):
        raise TypeError(f'OKed: tool "{name}" has no invoke function')
    opts = _ensure_client(options)
    try:
        from langchain_core.tools import BaseTool

        is_base = isinstance(tool, BaseTool)
    except ImportError:
        is_base = False
    if is_base:
        cloned = cast(Any, tool).model_copy(deep=False)
        object.__setattr__(cloned, _WRAPPED, True)

        def invoke(tool_input: object, config: object = None, **kwargs: Any) -> Any:
            return _invoke_gated(tool, opts, tool_input, config, kwargs)

        async def ainvoke(tool_input: object, config: object = None, **kwargs: Any) -> Any:
            import asyncio

            return await asyncio.to_thread(invoke, tool_input, config, **kwargs)

        object.__setattr__(cloned, "invoke", invoke)
        object.__setattr__(cloned, "ainvoke", ainvoke)
        return cloned
    return _DuckTool(tool, opts)


def with_oked_approvals(tools: Sequence[Any], **options: Any) -> list[Any]:
    """Wrap each tool with one shared client."""
    if isinstance(tools, (str, bytes)) or not isinstance(tools, Sequence):
        raise TypeError("OKed: with_oked_approvals expected a list of tools")
    shared = _ensure_client(dict(options))
    return [with_oked_approval(tool, **shared) for tool in tools]


class _DuckTool:
    """Proxy for a plain object that has name and invoke, used in unit tests."""

    def __init__(self, tool: Any, options: Mapping[str, Any]) -> None:
        object.__setattr__(self, "_tool", tool)
        object.__setattr__(self, "_options", options)
        object.__setattr__(self, _WRAPPED, True)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._tool, name)

    def invoke(self, tool_input: object, config: object = None, **kwargs: Any) -> Any:
        return _invoke_gated(self._tool, self._options, tool_input, config, kwargs)

    async def ainvoke(self, tool_input: object, config: object = None, **kwargs: Any) -> Any:
        import asyncio

        return await asyncio.to_thread(self.invoke, tool_input, config, **kwargs)
