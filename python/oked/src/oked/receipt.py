"""Signed receipt checks. Same rules as @oked/receipt-core and the SDK gate.

An approval counts only when an Ed25519 signature over JCS(body) verifies
under a published OKed key, for this request id, this decision, and the
exact action and nonce that were sent.
"""

from __future__ import annotations

import base64
import json
import os
import re
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Mapping
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from oked.errors import OkedReceiptError
from oked.jcs import canonicalize, json_value

OKED_RECEIPT_KEYS_URL = "https://api.oked.ai/.well-known/oked-receipt-keys.json"

# Shipped with the SDK so the first receipt verifies without a network call.
# A lookalike backend cannot supply its own key. On rotation, add the new
# key here and set not_after on the old one.
PINNED_RECEIPT_KEYS: list[dict[str, Any]] = [
    {
        "kid": "oked-2026-10",
        "alg": "Ed25519",
        "public_key": "C0YsmbAi0NLBz4eEDTwpusXlBMOzh30LXWkd-9dEiAw",
        "not_before": "2026-10-01T00:00:00.000Z",
        "not_after": None,
    }
]

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_DECISIONS = frozenset({"approved", "denied", "timed_out"})
_KINDS = frozenset({"human", "rule", "system"})


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def sha256_digest(text: str) -> str:
    return "sha256:" + sha256(text.encode("utf-8")).hexdigest()


def jcs_digest(value: Any) -> str:
    return sha256_digest(canonicalize(value))


def subject_digest(subject: Mapping[str, Any]) -> str:
    return jcs_digest(dict(subject))


def body_digest(body: Any) -> str:
    return jcs_digest(body)


def short_receipt_id(receipt_id: str) -> str:
    """Short form shown in Telegram and the dashboard, for example rcpt_7Q2FABCD."""
    return receipt_id[:13]


def response_decision(decision: str) -> str:
    """Receipt decision to the decision string /approve returns."""
    return "timeout" if decision == "timed_out" else decision


def _parse_time(text: object) -> float | None:
    if not isinstance(text, str):
        return None
    raw = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp() * 1000


def key_covers(key: Mapping[str, Any], iso_time: str) -> bool:
    """True when not_before <= t and (no not_after, or t < not_after)."""
    instant = _parse_time(iso_time)
    if instant is None:
        return False
    not_before = _parse_time(key.get("not_before"))
    if not_before is None or not_before > instant:
        return False
    not_after = key.get("not_after")
    if not_after is None:
        return True
    end = _parse_time(not_after)
    return end is not None and instant < end


def keys_url_allowed(url: str) -> bool:
    """A key not seen before is accepted only over TLS, or from this machine."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    if parsed.scheme == "https" and parsed.hostname:
        return True
    host = parsed.hostname or ""
    return parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "::1"}


def _receipt_keys_path() -> str:
    return os.path.join(os.path.expanduser("~"), ".oked", "receipt-keys.json")


def _read_cached_keys() -> list[dict[str, Any]]:
    try:
        with open(_receipt_keys_path(), encoding="utf-8") as handle:
            parsed = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []
    keys = parsed.get("keys") if isinstance(parsed, dict) else None
    return [item for item in keys if isinstance(item, dict)] if isinstance(keys, list) else []


def _write_cached_keys(keys: list[dict[str, Any]]) -> None:
    path = _receipt_keys_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"keys": keys}, handle)
    except OSError:
        return


def _fetch_keys(url: str) -> list[dict[str, Any]]:
    if not keys_url_allowed(url):
        return []
    from oked.transport import request_bytes

    try:
        status, _headers, body = request_bytes("GET", url, None, {}, 5.0)
    except Exception:
        return []
    if status < 200 or status >= 300:
        return []
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return []
    keys = parsed.get("keys") if isinstance(parsed, dict) else None
    return [item for item in keys if isinstance(item, dict)] if isinstance(keys, list) else []


def keys_for(kid: str, *, keys: list[dict[str, Any]] | None, keys_url: str) -> list[dict[str, Any]]:
    """Pinned keys plus the disk cache. Fetch only when the kid is unknown.

    An empty list still means "use exactly these keys and never fetch".
    """
    if keys is not None:
        return keys
    known = [*PINNED_RECEIPT_KEYS, *_read_cached_keys()]
    if any(item.get("kid") == kid for item in known):
        return known
    fetched = _fetch_keys(keys_url)
    if fetched:
        _write_cached_keys(fetched)
    return [*PINNED_RECEIPT_KEYS, *fetched]


def signature_valid(envelope: Mapping[str, Any], public_key: str) -> bool:
    try:
        message = canonicalize(envelope["body"]).encode("utf-8")
        key = Ed25519PublicKey.from_public_bytes(b64url_decode(public_key))
        sig = envelope.get("sig")
        if not isinstance(sig, str):
            return False
        key.verify(b64url_decode(sig), message)
        return True
    except Exception:
        return False


def public_key_from_seed(seed: str) -> str:
    private = Ed25519PrivateKey.from_private_bytes(b64url_decode(seed.strip()))
    raw = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return b64url_encode(raw)


def sign_body(body: Mapping[str, Any], seed: str, kid: str) -> dict[str, Any]:
    """Ed25519 over the UTF-8 bytes of JCS(body)."""
    private = Ed25519PrivateKey.from_private_bytes(b64url_decode(seed.strip()))
    material = dict(body)
    message = canonicalize(material).encode("utf-8")
    return {
        "body": material,
        "alg": "Ed25519",
        "kid": kid,
        "sig": b64url_encode(private.sign(message)),
    }


def _is_receipt_shape(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    body = value.get("body")
    if not isinstance(body, dict) or isinstance(body, list):
        return False
    if (
        value.get("alg") != "Ed25519"
        or not isinstance(value.get("kid"), str)
        or not isinstance(value.get("sig"), str)
    ):
        return False
    decider = body.get("decider")
    prev = body.get("prev_receipt_digest")
    digest = body.get("subject_digest")
    seq = body.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        return False
    return (
        body.get("v") == 1
        and isinstance(body.get("receipt_id"), str)
        and isinstance(body.get("chain_id"), str)
        and isinstance(body.get("issued_at"), str)
        and isinstance(body.get("request_id"), str)
        and isinstance(digest, str)
        and _DIGEST.match(digest) is not None
        and isinstance(body.get("decision"), str)
        and body.get("decision") in _DECISIONS
        and isinstance(decider, dict)
        and isinstance(decider.get("kind"), str)
        and decider.get("kind") in _KINDS
        and (prev is None or (isinstance(prev, str) and _DIGEST.match(prev) is not None))
    )


def _as_key_list(keys: list[dict[str, Any]] | Mapping[str, Any]) -> list[dict[str, Any]]:
    if isinstance(keys, list):
        return keys
    inner = keys.get("keys")
    if isinstance(inner, list):
        return [item for item in inner if isinstance(item, dict)]
    return []


def verify_receipt(
    receipt: object,
    *,
    keys: list[dict[str, Any]] | Mapping[str, Any],
    subject: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Check shape, key window, signature, and, when given, the subject.

    Returns ok, problems, and the key that was selected (omitted when the
    kid is unknown or the receipt is malformed).
    """
    if not _is_receipt_shape(receipt):
        return {"ok": False, "problems": ["malformed"]}
    assert isinstance(receipt, dict)
    key_list = _as_key_list(keys)
    match = next(
        (
            item
            for item in key_list
            if item.get("kid") == receipt.get("kid") and item.get("alg") == "Ed25519"
        ),
        None,
    )
    if match is None:
        return {"ok": False, "problems": ["unknown_kid"]}
    problems: list[str] = []
    body = receipt["body"]
    issued = body.get("issued_at")
    if not isinstance(issued, str) or not key_covers(match, issued):
        problems.append("key_not_valid_at_issued_at")
    public = match.get("public_key")
    if not isinstance(public, str) or not signature_valid(receipt, public):
        problems.append("bad_signature")
    if subject is not None:
        # JavaScript: null === undefined is false. A missing operator_id on
        # the body is not the null the client put in the subject.
        if "operator_id" in body:
            operator_matches = subject.get("operator_id") == body.get("operator_id")
        else:
            operator_matches = False
        matches = (
            subject.get("request_id") == body.get("request_id")
            and operator_matches
            and subject_digest(subject) == body.get("subject_digest")
        )
        if not matches:
            problems.append("subject_mismatch")
    result: dict[str, Any] = {"ok": not problems, "problems": problems, "key": match}
    return result


def check_receipt(
    result: Mapping[str, Any],
    *,
    action: str,
    description: Any,
    tool_input: Any,
    source: str,
    nonce: str,
    required: bool,
    keys: list[dict[str, Any]] | None,
    keys_url: str,
) -> dict[str, Any] | None:
    """Verify the receipt on a decision. Raises OkedReceiptError on failure.

    A missing receipt raises only for an approval when required is true.
    A deny or a timeout without one stays a plain denial.
    """
    if "receipt" not in result or result.get("receipt") is None:
        if required and result.get("decision") == "approved":
            raise OkedReceiptError("missing", ["missing"])
        return None
    receipt = result.get("receipt")
    if not isinstance(receipt, dict):
        raise OkedReceiptError("malformed", ["malformed"])
    kid_value = receipt.get("kid")
    kid = kid_value if isinstance(kid_value, str) else ""
    body = receipt.get("body")
    if not isinstance(body, dict):
        raise OkedReceiptError("malformed", ["malformed"])
    approval_id = result.get("approval_id")
    request_id = approval_id if isinstance(approval_id, str) else ""
    # body.operator_id ?? null: missing and null both hash as null.
    operator_id = body.get("operator_id") if "operator_id" in body else None
    subject = {
        "type": "tool_call",
        "operator_id": operator_id,
        "request_id": request_id,
        "source": source,
        "action": action,
        "description": json_value(description),
        "tool_input": json_value(tool_input),
        "client_nonce": nonce,
    }
    check = verify_receipt(
        receipt, keys=keys_for(kid, keys=keys, keys_url=keys_url), subject=subject
    )
    problems = list(check["problems"])
    if body.get("request_id") != result.get("approval_id"):
        problems.append("request_mismatch")
    decision = body.get("decision")
    if not isinstance(decision, str) or response_decision(decision) != result.get("decision"):
        problems.append("decision_mismatch")
    if problems:
        raise OkedReceiptError(", ".join(problems), problems)
    return receipt
