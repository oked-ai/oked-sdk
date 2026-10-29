"""LangGraph gate: approvals, tiers, and a real ToolNode."""

from __future__ import annotations

import socket
from typing import Any

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode, create_react_agent
from oked import (
    ApprovalResponse,
    OkedAuthError,
    OkedBackendUnreachableError,
    OkedClient,
    OkedHttpError,
    OkedReceiptError,
    OkedTooManyPendingError,
)
from typing_extensions import TypedDict

from oked_langgraph import (
    CLIENT_ID,
    create_oked_client,
    gate_tool_call,
    with_oked_approval,
    with_oked_approvals,
)

ALLOWED = ApprovalResponse(approved=True, approval_id="ap_ok", decision="approved")
DENIED = ApprovalResponse(approved=False, approval_id="ap_no", decision="denied")
TIMED_OUT = ApprovalResponse(approved=False, approval_id=None, decision="timeout")


class FakeClient:
    def __init__(self, **overrides: Any) -> None:
        self.api_key = overrides.get("api_key", "ok_test")
        self.strict_fail_closed = overrides.get("strict_fail_closed", False)
        self.rules = overrides.get("rules", [])
        self.rules_error = overrides.get("rules_error")
        self.approve_result = overrides.get("approve_result", ALLOWED)
        self.approve_error = overrides.get("approve_error")
        self.heartbeat_error = overrides.get("heartbeat_error")
        self.calls: list[dict[str, Any]] = []
        self.heartbeats = 0

    def heartbeat(self) -> None:
        if self.heartbeat_error:
            raise self.heartbeat_error
        self.heartbeats += 1

    def get_rules(self) -> list[Any]:
        if self.rules_error:
            raise self.rules_error
        return self.rules

    def approve(self, request: dict[str, Any]) -> ApprovalResponse:
        self.calls.append(dict(request))
        if self.approve_error:
            raise self.approve_error
        result = self.approve_result
        return result(request) if callable(result) else result


class RecordingTool:
    def __init__(self, name: str) -> None:
        self.name = name
        self.description = f"{name} tool"
        self.seen: list[tuple[Any, Any]] = []

    def invoke(self, tool_input: Any, config: Any = None, **kwargs: Any) -> str:
        self.seen.append((tool_input, config))
        return "ran"


def _call(name: str, args: dict[str, Any], call_id: str = "call_1") -> dict[str, Any]:
    return {"type": "tool_call", "id": call_id, "name": name, "args": args}


def test_approved_call_forwards_input_and_config() -> None:
    client = FakeClient()
    tool = RecordingTool("send_invoice")
    wrapped = with_oked_approval(tool, client=client, cwd="/srv/app")
    incoming = _call("send_invoice", {"amount": 2400, "currency": "EUR"})
    config = {"configurable": {"thread_id": "thread-9"}, "tags": ["agent"]}
    assert wrapped.invoke(incoming, config) == "ran"
    assert tool.seen == [(incoming, config)]
    assert client.calls[0]["action"] == "send_invoice"
    assert client.calls[0]["tier"] == "review"
    assert client.calls[0]["tool_input"] == incoming["args"]
    assert client.calls[0]["session_id"] == "thread-9"
    assert client.calls[0]["cwd"] == "/srv/app"
    assert client.calls[0]["fields"]["Title"] == "send_invoice"
    assert client.heartbeats == 1


def test_session_id_wins_over_thread_id() -> None:
    client = FakeClient()
    tool = RecordingTool("send_invoice")
    wrapped = with_oked_approval(tool, client=client, session_id="explicit")
    wrapped.invoke(
        _call("send_invoice", {"amount": 1}), {"configurable": {"thread_id": "thread", "session_id": "other"}}
    )
    assert client.calls[0]["session_id"] == "explicit"


def test_deny_timeout_and_errors_do_not_run_the_tool() -> None:
    cases = [
        (DENIED, "DENIED"),
        (TIMED_OUT, "did not respond"),
        (OkedReceiptError("bad_signature", ["bad_signature"]), "did not verify"),
        (OkedAuthError("nope", 401), "invalid API key"),
        (OkedTooManyPendingError("too many"), "too many approvals"),
        (OkedHttpError(400, "action is required"), "HTTP 400"),
        (RuntimeError("boom"), "unexpected error"),
    ]
    for item, snippet in cases:
        client = FakeClient()
        tool = RecordingTool("send_invoice")
        if isinstance(item, ApprovalResponse):
            client.approve_result = item
        else:
            client.approve_error = item
        wrapped = with_oked_approval(tool, client=client)
        result = wrapped.invoke(_call("send_invoice", {"amount": 1}, "c1"))
        assert tool.seen == []
        assert result.status == "error"
        assert result.tool_call_id == "c1"
        assert snippet in result.content
        assert "was not run" in result.content
        assert "Please fix your mistakes" not in result.content


def test_unreachable_high_stakes_denies_and_review_may_run() -> None:
    outage = OkedBackendUnreachableError("down")
    high = FakeClient(approve_error=outage)
    high_tool = RecordingTool("shell")
    denied = with_oked_approval(high_tool, client=high, tier="high_stakes").invoke(
        _call("shell", {"command": "rm -rf ./src"})
    )
    assert high_tool.seen == []
    assert "high-stakes" in denied.content

    review = FakeClient(approve_error=outage)
    review_tool = RecordingTool("send_invoice")
    assert with_oked_approval(review_tool, client=review).invoke(_call("send_invoice", {"amount": 1})) == "ran"
    assert review.calls[0]["tier"] == "review"

    strict = FakeClient(approve_error=outage, strict_fail_closed=True)
    strict_tool = RecordingTool("send_invoice")
    blocked = with_oked_approval(strict_tool, client=strict).invoke(_call("send_invoice", {"amount": 1}))
    assert strict_tool.seen == []
    assert "strict fail-closed" in blocked.content


def test_min_tier_always_allow_and_rules() -> None:
    client = FakeClient(approve_result=DENIED)
    review = RecordingTool("send_invoice")
    assert (
        with_oked_approval(review, client=client, min_tier="high_stakes").invoke(_call("send_invoice", {"amount": 1}))
        == "ran"
    )
    assert client.calls == []

    shell = RecordingTool("shell")
    shell_denied = with_oked_approval(shell, client=client, min_tier="high_stakes").invoke(
        _call("shell", {"command": "rm -rf ./src"})
    )
    assert shell.seen == []
    assert "DENIED" in shell_denied.content
    assert client.calls[0]["tier"] == "high_stakes"

    allowed_shell = RecordingTool("shell")
    assert (
        with_oked_approval(allowed_shell, client=client, always_allow=["shell"]).invoke(
            _call("shell", {"command": "rm -rf ./src"})
        )
        == "ran"
    )

    listed = RecordingTool("list_files")
    forced = with_oked_approval(listed, client=client, always_approve=["list_files"]).invoke(_call("list_files", {}))
    assert "DENIED" in forced.content
    assert listed.seen == []
    assert client.calls[-1]["tier"] == "high_stakes"

    safe = FakeClient(
        rules=[{"id": "rule_1", "match": {"title": {"op": "equals", "value": "list_files"}}, "action": "auto_deny"}],
        approve_result=DENIED,
    )
    listed2 = RecordingTool("list_files")
    blocked = with_oked_approval(listed2, client=safe).invoke(_call("list_files", {}))
    assert "DENIED" in blocked.content
    assert safe.calls

    miss = FakeClient(
        rules=[{"id": "rule_2", "match": {"title": {"op": "equals", "value": "other"}}, "action": "auto_deny"}],
        approve_result=DENIED,
    )
    assert with_oked_approval(RecordingTool("list_files"), client=miss).invoke(_call("list_files", {})) == "ran"
    assert miss.calls == []


def test_missing_key_does_not_call_approve() -> None:
    client = FakeClient(api_key="")
    tool = RecordingTool("send_invoice")
    result = with_oked_approval(tool, client=client).invoke({"amount": 9})
    assert tool.seen == []
    assert client.calls == []
    assert "no API key" in result
    assert "was not run" in result


def test_env_min_tier(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OKED_MIN_TIER", "high_stakes")
    client = FakeClient(approve_result=DENIED)
    tool = RecordingTool("send_invoice")
    assert with_oked_approval(tool, client=client).invoke(_call("send_invoice", {"amount": 1})) == "ran"
    assert client.calls == []


def test_gate_tool_call_reports_the_decision() -> None:
    denied = gate_tool_call("send_invoice", {"amount": 3}, client=FakeClient(approve_result=DENIED))
    assert denied["run"] is False
    assert denied["decision"] == "denied"
    assert "was not run" in denied["message"]
    allowed = gate_tool_call("send_invoice", {"amount": 4}, client=FakeClient())
    assert allowed["run"] is True
    assert allowed["decision"] == "approved"


def test_create_oked_client_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OKED_API_KEY", "ok_from_env")
    monkeypatch.delenv("OKED_STRICT_FAIL_CLOSED", raising=False)
    client = create_oked_client()
    assert client.api_key == "ok_from_env"
    assert client.strict_fail_closed is False
    assert CLIENT_ID.startswith("oked-langgraph-py@")
    explicit = create_oked_client(api_key="ok_explicit", strict_fail_closed=True)
    assert explicit.api_key == "ok_explicit"
    assert explicit.strict_fail_closed is True


def test_closed_port_high_stakes_does_not_run() -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    client = OkedClient(api_key="ok_test", backend_url=f"http://127.0.0.1:{port}", timeout=2000, require_receipt=False)
    tool = RecordingTool("shell")
    result = with_oked_approval(tool, client=client, tier="high_stakes").invoke(
        _call("shell", {"command": "rm -rf ./src"})
    )
    assert tool.seen == []
    assert "was not run" in result.content


def test_invalid_tools_raise() -> None:
    with pytest.raises(TypeError, match="LangChain tool"):
        with_oked_approval(None)
    with pytest.raises(TypeError, match="name"):
        with_oked_approval({"name": "", "invoke": lambda *_a, **_k: None})
    with pytest.raises(TypeError, match="invoke"):
        with_oked_approval(type("T", (), {"name": "x"})())
    with pytest.raises(TypeError, match="list"):
        with_oked_approvals("nope")  # type: ignore[arg-type]


def test_toolnode_runs_only_the_approved_tool_and_create_react_agent_accepts_the_wrapper() -> None:
    calls: list[tuple[Any, ...]] = []

    @tool
    def send_email(to: str, body: str) -> str:
        """Send an email."""
        calls.append(("send_email", to, body))
        return "sent"

    @tool
    def create_invoice(amount: int) -> str:
        """Create an invoice."""
        calls.append(("create_invoice", amount))
        return "created"

    client = FakeClient(
        approve_result=lambda request: ALLOWED if request["action"] == "create_invoice" else DENIED,
    )
    wrapped = with_oked_approvals([send_email, create_invoice], client=client)
    assert wrapped[0].name == "send_email"
    assert wrapped[0].description == send_email.description
    assert wrapped[0].args_schema is send_email.args_schema
    assert with_oked_approval(wrapped[0], client=FakeClient(approve_result=DENIED)) is wrapped[0]

    class _State(TypedDict):
        messages: list[Any]

    graph = StateGraph(_State)
    graph.add_node("tools", ToolNode(wrapped))
    graph.add_edge(START, "tools")
    graph.add_edge("tools", END)
    result = graph.compile().invoke(
        {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "send_email",
                            "args": {"to": "a@example.com", "body": "hi"},
                            "id": "c_send",
                            "type": "tool_call",
                        },
                        {"name": "create_invoice", "args": {"amount": 10}, "id": "c_inv", "type": "tool_call"},
                    ],
                )
            ]
        }
    )
    messages = result["messages"]
    denied = next(message for message in messages if message.tool_call_id == "c_send")
    allowed = next(message for message in messages if message.tool_call_id == "c_inv")
    assert "USER DENIED send_email" in denied.content
    assert "was not run" in denied.content
    assert denied.status == "error"
    assert "Please fix your mistakes" not in denied.content
    assert allowed.content == "created"
    assert calls == [("create_invoice", 10)]
    assert client.calls[0]["tool_input"] == {"to": "a@example.com", "body": "hi"}
    assert client.calls[1]["tool_input"] == {"amount": 10}

    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult

    class _Model(BaseChatModel):
        calls: int = 0

        @property
        def _llm_type(self) -> str:
            return "fake"

        def _generate(
            self, messages: list[Any], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
        ) -> ChatResult:
            self.calls += 1
            if self.calls == 1:
                message = AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "send_email",
                            "args": {"to": "b@example.com", "body": "no"},
                            "id": "a_send",
                            "type": "tool_call",
                        },
                        {"name": "create_invoice", "args": {"amount": 4}, "id": "a_inv", "type": "tool_call"},
                    ],
                )
            else:
                message = AIMessage(content="done")
            return ChatResult(generations=[ChatGeneration(message=message)])

        def bind_tools(self, tools: list[Any], **kwargs: Any) -> "_Model":
            return self

    before = len(calls)
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        agent = create_react_agent(_Model(), wrapped)
    agent_result = agent.invoke({"messages": [("user", "send and invoice")]})
    assert agent_result["messages"][-1].content == "done"
    assert calls[before:] == [("create_invoice", 4)]
    assert any(
        getattr(message, "tool_call_id", None) == "a_send" and "was not run" in message.content
        for message in agent_result["messages"]
    )
