"""OKed approval client. Sync and async.

approve() posts to /api/v1/approve and waits for a person. The default wait
is 630 seconds, 30 seconds past the backend's 10 minute window, so the
backend's timeout answer arrives before the client gives up.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Mapping

from oked.config import PersistedConfig, heartbeat_path, load_oked_config, rules_cache_path
from oked.errors import (
    OkedAuthError,
    OkedBackendUnreachableError,
    OkedHttpError,
    OkedTooManyPendingError,
)
from oked.receipt import OKED_RECEIPT_KEYS_URL, check_receipt
from oked.transport import ConnectFailed, HeldTimeout, request_bytes, request_with_retry
from oked.types import ApprovalRequest, ApprovalResponse

# 30s above the backend's 10 minute expiry.
DEFAULT_APPROVAL_TIMEOUT_MS = 630_000

_DEFAULT_BACKEND = "https://api.oked.ai"


def _env_flag(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    return raw == "1" or raw.lower() == "true"


def _env_seconds(name: str) -> float | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


def _rules_cache_key(backend_url: str, api_key: str) -> str:
    """djb2, then base36. Same key the TypeScript client writes to disk."""
    digest = 5381
    for char in f"{backend_url}|{api_key}":
        digest = ((digest << 5) + digest + ord(char)) & 0xFFFFFFFF
    if digest == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    chars: list[str] = []
    while digest:
        digest, remainder = divmod(digest, 36)
        chars.append(digits[remainder])
    return "".join(reversed(chars))


def _read_json_object(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as handle:
            parsed = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _write_json(path: str, payload: Mapping[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except OSError:
        return


def _short_detail(body: str) -> str:
    line = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", body)).strip()
    return line[:197] + "..." if len(line) > 200 else line


def _is_json(text: str) -> bool:
    try:
        json.loads(text)
        return True
    except json.JSONDecodeError:
        return False


def _error_field(body: str) -> str:
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return ""
    if not isinstance(parsed, dict):
        return ""
    error = parsed.get("error")
    message = parsed.get("message")
    value = error if isinstance(error, str) else message if isinstance(message, str) else ""
    return _short_detail(value)


def _pick_bool(
    explicit: bool | None, env: bool | None, persisted: bool | None, default: bool
) -> bool:
    if explicit is not None:
        return explicit
    if env is not None:
        return env
    if persisted is not None:
        return persisted
    return default


def _pick_ms(
    explicit_ms: int | None,
    env_seconds: float | None,
    persisted_seconds: float | None,
    default_ms: int,
) -> int:
    if explicit_ms is not None:
        return explicit_ms
    if env_seconds is not None:
        return int(env_seconds * 1000)
    if persisted_seconds is not None:
        return int(persisted_seconds * 1000)
    return default_ms


def _request_mapping(request: ApprovalRequest | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(request, ApprovalRequest):
        data = asdict(request)
        # asdict turns missing optionals into None. Drop them so they are
        # omitted on the wire the way an unset TypeScript field is omitted.
        return {
            key: value
            for key, value in data.items()
            if value is not None or key in {"action", "description", "tier"}
        }
    if isinstance(request, Mapping):
        return dict(request)
    raise TypeError("approve() expected an ApprovalRequest or a mapping")


@dataclass
class _Settings:
    api_key: str
    backend_url: str
    timeout_ms: int
    strict_fail_closed: bool
    rules_cache_ttl_ms: int
    heartbeat_interval_ms: int
    require_receipt: bool
    receipt_keys_url: str
    receipt_keys: list[dict[str, Any]] | None
    client: str | None
    source: str | None


class OkedClient:
    """Ask a person before a risky action runs.

    The API key comes from the constructor, then OKED_API_KEY, then
    ~/.oked/config.json.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        backend_url: str | None = None,
        timeout: int | None = None,
        strict_fail_closed: bool | None = None,
        rules_cache_ttl_ms: int | None = None,
        heartbeat_interval_ms: int | None = None,
        require_receipt: bool | None = None,
        receipt_keys_url: str | None = None,
        receipt_keys: list[dict[str, Any]] | None = None,
        client: str | None = None,
        source: str | None = None,
    ) -> None:
        persisted: PersistedConfig = load_oked_config()
        self._settings = _Settings(
            api_key=api_key or os.environ.get("OKED_API_KEY") or persisted.api_key or "",
            backend_url=backend_url
            or os.environ.get("OKED_BACKEND_URL")
            or persisted.backend_url
            or _DEFAULT_BACKEND,
            timeout_ms=timeout or DEFAULT_APPROVAL_TIMEOUT_MS,
            strict_fail_closed=_pick_bool(
                strict_fail_closed,
                _env_flag("OKED_STRICT_FAIL_CLOSED"),
                persisted.strict_fail_closed,
                False,
            ),
            rules_cache_ttl_ms=_pick_ms(
                rules_cache_ttl_ms,
                _env_seconds("OKED_RULES_CACHE_TTL"),
                persisted.rules_cache_ttl_seconds,
                300_000,
            ),
            heartbeat_interval_ms=_pick_ms(
                heartbeat_interval_ms,
                _env_seconds("OKED_HEARTBEAT_INTERVAL"),
                persisted.heartbeat_interval_seconds,
                86_400_000,
            ),
            require_receipt=_pick_bool(
                require_receipt,
                _env_flag("OKED_REQUIRE_RECEIPT"),
                persisted.require_receipt,
                True,
            ),
            receipt_keys_url=(
                receipt_keys_url
                or os.environ.get("OKED_RECEIPT_KEYS_URL")
                or persisted.receipt_keys_url
                or OKED_RECEIPT_KEYS_URL
            ),
            receipt_keys=receipt_keys,
            client=client,
            source=source,
        )

    @property
    def api_key(self) -> str:
        return self._settings.api_key

    @property
    def backend_url(self) -> str:
        return self._settings.backend_url

    @property
    def strict_fail_closed(self) -> bool:
        return self._settings.strict_fail_closed

    @property
    def require_receipt(self) -> bool:
        return self._settings.require_receipt

    def approve(self, request: ApprovalRequest | Mapping[str, Any]) -> ApprovalResponse:
        """Wait for a decision. A timeout is a denial, returned, not raised."""
        payload_in = _request_mapping(request)
        nonce = str(uuid.uuid4())
        source = self._settings.source or "sdk"
        metadata: dict[str, Any] = {}
        if "tool_input" in payload_in:
            metadata["tool_input"] = payload_in.get("tool_input")
        if payload_in.get("session_id") is not None:
            metadata["session_id"] = payload_in.get("session_id")
        if payload_in.get("cwd") is not None:
            metadata["cwd"] = payload_in.get("cwd")
        if self._settings.source:
            metadata["source"] = self._settings.source
        body: dict[str, Any] = {
            "action": payload_in.get("action"),
            "description": payload_in.get("description"),
            "tier": payload_in.get("tier"),
            "nonce": nonce,
        }
        if payload_in.get("fields") is not None:
            body["fields"] = payload_in.get("fields")
        if self._settings.client:
            body["client"] = self._settings.client
        body["metadata"] = metadata
        raw = json.dumps(body).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._settings.api_key}",
        }
        url = f"{self._settings.backend_url}/api/v1/approve"
        timeout_s = self._settings.timeout_ms / 1000
        try:
            status, response_headers, response_body = request_with_retry(
                "POST", url, raw, headers, timeout_s
            )
        except HeldTimeout:
            return ApprovalResponse(approved=False, approval_id=None, decision="timeout")
        except (ConnectFailed, OSError) as exc:
            raise OkedBackendUnreachableError(
                f"OKed backend unreachable: {exc}",
                cause=exc,
            ) from exc
        text = response_body.decode("utf-8", errors="replace")
        return self._interpret(status, response_headers, text, payload_in, source, nonce)

    async def approve_async(self, request: ApprovalRequest | Mapping[str, Any]) -> ApprovalResponse:
        """Async approve(). The wait runs in a worker thread."""
        return await asyncio.to_thread(self.approve, request)

    def _interpret(
        self,
        status: int,
        headers: Mapping[str, str],
        text: str,
        request: Mapping[str, Any],
        source: str,
        nonce: str,
    ) -> ApprovalResponse:
        if status == 504:
            return ApprovalResponse(approved=False, approval_id=None, decision="timeout")
        if status in {401, 403}:
            raise OkedAuthError(f"OKed backend error {status}: {text}", status)
        if not (200 <= status < 300):
            detail = _short_detail(text)
            if status == 429:
                raise OkedTooManyPendingError(_error_field(text) or detail)
            if headers.get("x-railway-fallback") or re.search(
                r"application not found", text, re.IGNORECASE
            ):
                raise OkedBackendUnreachableError(
                    f"OKed backend unreachable: HTTP {status}, the hosting platform answered "
                    f'"application not found" ({self._settings.backend_url})',
                    status=status,
                )
            if not _is_json(text):
                extra = f": {detail}" if detail else ""
                raise OkedBackendUnreachableError(
                    f"OKed backend unreachable: HTTP {status} with a reply that is not JSON{extra}",
                    status=status,
                )
            if status >= 500:
                raise OkedBackendUnreachableError(
                    f"OKed backend error HTTP {status}: {detail}",
                    status=status,
                )
            raise OkedHttpError(status, _error_field(text) or detail)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            content_type = headers.get("content-type") or "none"
            raise OkedBackendUnreachableError(
                f"OKed backend unreachable: HTTP {status} with a reply that is not JSON "
                f"(content-type {content_type})",
                cause=exc,
                status=status,
            ) from exc
        if not isinstance(parsed, dict) or not isinstance(parsed.get("decision"), str):
            content_type = headers.get("content-type") or "none"
            raise OkedBackendUnreachableError(
                f"OKed backend unreachable: HTTP {status} with a reply that is not JSON "
                f"(content-type {content_type})",
                status=status,
            )
        receipt = check_receipt(
            parsed,
            action=str(request.get("action")),
            description=request.get("description"),
            tool_input=request.get("tool_input"),
            source=source,
            nonce=nonce,
            required=self._settings.require_receipt,
            keys=self._settings.receipt_keys,
            keys_url=self._settings.receipt_keys_url,
        )
        decision = parsed["decision"]
        approval_id = parsed.get("approval_id")
        return ApprovalResponse(
            approved=decision == "approved",
            approval_id=approval_id if isinstance(approval_id, str) else None,
            decision=decision,
            receipt=receipt,
        )

    def get_rules(self) -> list[Any]:
        """Operator rules, cached on disk. Never raises."""
        if not self._settings.api_key:
            return []
        key = _rules_cache_key(self._settings.backend_url, self._settings.api_key)
        cache = _read_json_object(rules_cache_path())
        entry = cache.get(key)
        now = _now_ms()
        if isinstance(entry, dict) and isinstance(entry.get("at"), (int, float)):
            if now - float(entry["at"]) < self._settings.rules_cache_ttl_ms and isinstance(
                entry.get("rules"), list
            ):
                return list(entry["rules"])
        cached_rules = (
            entry.get("rules")
            if isinstance(entry, dict) and isinstance(entry.get("rules"), list)
            else None
        )
        try:
            status, _headers, body = request_bytes(
                "GET",
                f"{self._settings.backend_url}/api/v1/rules",
                None,
                {"Authorization": f"Bearer {self._settings.api_key}"},
                5.0,
            )
            if not 200 <= status < 300:
                return list(cached_rules) if cached_rules is not None else []
            parsed = json.loads(body.decode("utf-8"))
            if not isinstance(parsed, list):
                return list(cached_rules) if cached_rules is not None else []
            cache[key] = {"at": _now_ms(), "rules": parsed}
            _write_json(rules_cache_path(), cache)
            return parsed
        except Exception:
            return list(cached_rules) if cached_rules is not None else []

    async def get_rules_async(self) -> list[Any]:
        return await asyncio.to_thread(self.get_rules)

    def ping(self) -> bool:
        try:
            status, _headers, _body = request_bytes(
                "GET", f"{self._settings.backend_url}/health", None, {}, 3.0
            )
            return 200 <= status < 300
        except Exception:
            return False

    async def ping_async(self) -> bool:
        return await asyncio.to_thread(self.ping)

    def heartbeat(self) -> None:
        """Presence ping, at most once per interval. Never raises."""
        if not self._settings.api_key:
            return
        key = _rules_cache_key(self._settings.backend_url, self._settings.api_key)
        path = heartbeat_path()
        stamps = _read_json_object(path)
        last = stamps.get(key)
        now = _now_ms()
        if (
            isinstance(last, (int, float))
            and not isinstance(last, bool)
            and now - float(last) < self._settings.heartbeat_interval_ms
        ):
            return
        try:
            status, _headers, _body = request_bytes(
                "POST",
                f"{self._settings.backend_url}/api/v1/heartbeat",
                json.dumps({"hostname": socket.gethostname()}).encode("utf-8"),
                {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._settings.api_key}",
                },
                3.0,
            )
            if 200 <= status < 300:
                stamps[key] = _now_ms()
                _write_json(path, stamps)
        except Exception:
            return

    async def heartbeat_async(self) -> None:
        await asyncio.to_thread(self.heartbeat)


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)
