"""OkedClient.approve against a local stub of the approval API."""

from __future__ import annotations

import json
import socket
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from oked import (
    OkedAuthError,
    OkedBackendUnreachableError,
    OkedClient,
    OkedHttpError,
    OkedReceiptError,
    OkedTooManyPendingError,
    degraded_decision,
)
from oked.client import _rules_cache_key
from oked.jcs import json_value
from oked.receipt import b64url_encode, public_key_from_seed, sign_body, subject_digest


def _fresh_key() -> tuple[str, dict[str, Any]]:
    raw = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    seed = b64url_encode(raw)
    key = {
        "kid": "test-key",
        "alg": "Ed25519",
        "public_key": public_key_from_seed(seed),
        "not_before": "2020-01-01T00:00:00.000Z",
        "not_after": None,
    }
    return seed, key


def _iso_now() -> str:
    moment = datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _receipt(seed: str, sent: dict[str, Any], *, decision: str = "approved", summary: str = "probe") -> dict[str, Any]:
    request_id = "req-test"
    metadata = sent.get("metadata") or {}
    source = metadata.get("source") or "sdk"
    receipt_decision = "timed_out" if decision == "timeout" else decision
    subject = {
        "type": "tool_call",
        "operator_id": None,
        "request_id": request_id,
        "source": source,
        "action": sent["action"],
        "description": json_value(sent.get("description")),
        "tool_input": json_value(metadata.get("tool_input")),
        "client_nonce": sent.get("nonce"),
    }
    body = {
        "v": 1,
        "receipt_id": "rcpt_TESTRECEIPT000000000000",
        "chain_id": "key_test",
        "seq": 1,
        "issued_at": _iso_now(),
        "issuer": "test",
        "operator_id": None,
        "request_id": request_id,
        "subject_type": "tool_call",
        "subject_digest": subject_digest(subject),
        "display_digest": None,
        "summary": summary,
        "risk_tier": sent.get("tier") or "review",
        "decision": receipt_decision,
        "decided_at": _iso_now(),
        "decider": {
            "kind": "human",
            "operator_id": None,
            "display_name": "Tester",
            "assurance": "channel",
            "channel": "dashboard",
            "rule_id": None,
            "reason": None,
        },
        "requester": {"operator_id": None, "api_key_id": None, "client": sent.get("client")},
        "same_person": False,
        "prev_receipt_digest": None,
    }
    return {
        "approval_id": request_id,
        "decision": decision,
        "status": decision,
        "receipt": sign_body(body, seed, "test-key"),
    }


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, responder: Callable[[str, bytes, Any], tuple[int, dict[str, str], bytes]]) -> None:
        self.responder = responder
        self.seen: list[tuple[str, bytes, dict[str, str]]] = []
        super().__init__(("127.0.0.1", 0), _Handler)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _Handler(BaseHTTPRequestHandler):
    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        server: _Server = self.server  # type: ignore[assignment]
        server.seen.append((self.path, raw, {k.lower(): v for k, v in self.headers.items()}))
        status, headers, body = server.responder(self.path, raw, self.headers)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def log_message(self, fmt: str, *args: object) -> None:
        return


@pytest.fixture
def serve():
    servers: list[_Server] = []

    def start(responder: Callable[[str, bytes, Any], tuple[int, dict[str, str], bytes]]) -> _Server:
        server = _Server(responder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def _json(status: int, payload: object, **headers: str) -> tuple[int, dict[str, str], bytes]:
    extra = {"Content-Type": "application/json", **headers}
    return status, extra, json.dumps(payload).encode()


def test_rules_cache_key_matches_the_typescript_client() -> None:
    assert _rules_cache_key("https://api.oked.ai", "ok_test_key") == "1pv0dio"


def test_degraded_decision_denies_only_high_stakes_unless_strict() -> None:
    assert degraded_decision("review") == "allow"
    assert degraded_decision("high_stakes") == "deny"
    assert degraded_decision("warning", strict_fail_closed=True) == "deny"


def test_config_file_and_env_precedence(isolate_home, monkeypatch) -> None:
    (isolate_home / ".oked").mkdir()
    (isolate_home / ".oked" / "config.json").write_text(json.dumps({"apiKey": "from-file", "strictFailClosed": True}))
    client = OkedClient()
    assert client.api_key == "from-file"
    assert client.strict_fail_closed is True
    monkeypatch.setenv("OKED_API_KEY", "from-env")
    monkeypatch.setenv("OKED_STRICT_FAIL_CLOSED", "1")
    from_env = OkedClient(strict_fail_closed=False)
    assert from_env.api_key == "from-env"
    assert from_env.strict_fail_closed is False
    assert OkedClient().strict_fail_closed is True


def test_approve_deny_and_request_shape(serve) -> None:
    seed, key = _fresh_key()

    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        if path.endswith("/heartbeat"):
            return 204, {}, b""
        sent = json.loads(raw)
        return _json(200, _receipt(seed, sent, decision="denied"))

    server = serve(respond)
    client = OkedClient(api_key="ok_test", backend_url=server.url, timeout=5000, receipt_keys=[key])
    result = client.approve(
        {
            "action": "send_invoice",
            "description": "Send invoice",
            "tier": "review",
            "tool_input": {"amount": 10},
            "session_id": "thread-9",
            "cwd": "/srv/app",
        }
    )
    assert result.approved is False
    assert result.decision == "denied"
    assert result.approval_id == "req-test"
    body = json.loads(server.seen[-1][1])
    assert body["action"] == "send_invoice"
    assert body["tier"] == "review"
    assert body["nonce"]
    assert body["metadata"]["tool_input"] == {"amount": 10}
    assert body["metadata"]["session_id"] == "thread-9"
    assert body["metadata"]["cwd"] == "/srv/app"
    assert server.seen[-1][2]["authorization"] == "Bearer ok_test"


def test_approve_with_a_valid_receipt(serve) -> None:
    seed, key = _fresh_key()

    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        return _json(200, _receipt(seed, json.loads(raw), decision="approved"))

    server = serve(respond)
    client = OkedClient(
        api_key="ok_test",
        backend_url=server.url,
        timeout=5000,
        receipt_keys=[key],
        client="oked-langgraph-py@0.6.21",
        source="langgraph",
    )
    result = client.approve(
        {
            "action": "send_invoice",
            "description": "Send",
            "tier": "high_stakes",
            "tool_input": {"n": 1},
        }
    )
    assert result.approved is True
    assert result.receipt is not None
    assert result.receipt["body"]["requester"]["client"] == "oked-langgraph-py@0.6.21"


def test_tampered_receipt_and_missing_receipt(serve) -> None:
    seed, key = _fresh_key()
    mode = {"value": "tamper"}

    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        payload = _receipt(seed, json.loads(raw))
        if mode["value"] == "tamper":
            payload["receipt"]["body"]["summary"] = "changed"
        elif mode["value"] == "none":
            payload.pop("receipt")
        return _json(200, payload)

    server = serve(respond)
    client = OkedClient(api_key="k", backend_url=server.url, timeout=5000, receipt_keys=[key])
    ask = {
        "action": "Bash",
        "description": "push",
        "tier": "high_stakes",
        "tool_input": {"command": "git push --force"},
    }
    with pytest.raises(OkedReceiptError) as tampered:
        client.approve(ask)
    assert "bad_signature" in tampered.value.problems
    mode["value"] = "none"
    with pytest.raises(OkedReceiptError) as missing:
        client.approve(ask)
    assert "missing" in missing.value.problems
    relaxed = OkedClient(api_key="k", backend_url=server.url, timeout=5000, receipt_keys=[key], require_receipt=False)
    allowed = relaxed.approve(ask)
    assert allowed.approved is True
    assert allowed.receipt is None


def test_auth_429_and_other_http_errors(serve) -> None:
    replies = {"status": 401, "body": {"message": "API key required"}}

    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        return _json(replies["status"], replies["body"])

    server = serve(respond)
    client = OkedClient(api_key="k", backend_url=server.url, timeout=5000, require_receipt=False)

    def ask() -> None:
        client.approve({"action": "Bash", "description": "x", "tier": "review"})

    with pytest.raises(OkedAuthError):
        ask()
    replies["status"] = 429
    replies["body"] = {"error": "too many pending approvals for this operator"}
    with pytest.raises(OkedTooManyPendingError) as limited:
        ask()
    assert limited.value.status == 429
    assert "too many approvals are waiting" in str(limited.value)
    replies["status"] = 400
    replies["body"] = {"error": "action is required"}
    with pytest.raises(OkedHttpError) as http:
        ask()
    assert http.value.status == 400
    assert http.value.detail == "action is required"
    replies["status"] = 503
    replies["body"] = {"error": "down"}
    with pytest.raises(OkedBackendUnreachableError) as down:
        ask()
    assert down.value.status == 503


def test_non_json_and_application_not_found_are_outages(serve) -> None:
    state = {
        "body": b"<html><body><h1>Not Found</h1>" + b"x" * 500,
        "status": 404,
        "headers": {"Content-Type": "text/html"},
    }

    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        return state["status"], state["headers"], state["body"]

    server = serve(respond)
    client = OkedClient(api_key="k", backend_url=server.url, timeout=5000, require_receipt=False)
    with pytest.raises(OkedBackendUnreachableError) as missing:
        client.approve({"action": "x", "description": "y", "tier": "review"})
    assert "not JSON" in str(missing.value)
    assert "<h1>" not in str(missing.value)
    state["headers"] = {"Content-Type": "application/json", "x-railway-fallback": "true"}
    state["body"] = json.dumps({"message": "Application not found"}).encode()
    with pytest.raises(OkedBackendUnreachableError) as platform:
        client.approve({"action": "x", "description": "y", "tier": "review"})
    assert platform.value.status == 404


def test_held_request_times_out_instead_of_failing_open(serve) -> None:
    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        if path.endswith("/heartbeat"):
            return 204, {}, b""
        time.sleep(5)
        return _json(200, {"approval_id": "late", "decision": "approved", "status": "approved"})

    server = serve(respond)
    client = OkedClient(api_key="k", backend_url=server.url, timeout=300, require_receipt=False)
    result = client.approve({"action": "send_invoice", "description": "x", "tier": "review"})
    assert result.approved is False
    assert result.decision == "timeout"
    assert result.approval_id is None


def test_closed_port_is_unreachable() -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    client = OkedClient(api_key="k", backend_url=f"http://127.0.0.1:{port}", timeout=2000, require_receipt=False)
    with pytest.raises(OkedBackendUnreachableError):
        client.approve({"action": "x", "description": "y", "tier": "high_stakes"})


def test_gateway_504_is_a_timeout(serve) -> None:
    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        return 504, {"Content-Type": "text/plain"}, b"gateway"

    server = serve(respond)
    client = OkedClient(api_key="k", backend_url=server.url, timeout=2000, require_receipt=False)
    result = client.approve({"action": "x", "description": "y", "tier": "review"})
    assert result.decision == "timeout"
    assert result.approved is False


def test_approve_async(serve) -> None:
    import asyncio

    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        return _json(200, {"approval_id": "a1", "decision": "denied", "status": "denied"})

    server = serve(respond)
    client = OkedClient(api_key="k", backend_url=server.url, timeout=5000, require_receipt=False)
    result = asyncio.run(client.approve_async({"action": "x", "description": "y", "tier": "review"}))
    assert result.decision == "denied"


def test_get_rules_and_heartbeat(serve, isolate_home) -> None:
    def respond(path: str, raw: bytes, _headers: Any) -> tuple[int, dict[str, str], bytes]:
        if path.endswith("/rules"):
            return _json(
                200,
                [
                    {
                        "id": "r1",
                        "match": {"title": {"op": "equals", "value": "x"}},
                        "action": "auto_deny",
                    }
                ],
            )
        return 204, {}, b""

    server = serve(respond)
    client = OkedClient(
        api_key="ok_test",
        backend_url=server.url,
        rules_cache_ttl_ms=60_000,
        heartbeat_interval_ms=60_000,
    )
    rules = client.get_rules()
    assert rules[0]["id"] == "r1"
    assert client.get_rules()[0]["id"] == "r1"
    client.heartbeat()
    client.heartbeat()
    posts = [item for item in server.seen if item[0].endswith("/heartbeat")]
    assert len(posts) == 1
    assert OkedClient(api_key="", backend_url=server.url).get_rules() == []
