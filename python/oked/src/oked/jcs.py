"""RFC 8785 JSON Canonicalization Scheme, matching @oked/receipt-core.

Numbers use the ECMAScript serialization JSON.stringify produces. Object
keys sort by UTF-16 code unit, which is JavaScript string order.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any


def _es_number(number: int | float) -> str:
    if isinstance(number, bool) or not isinstance(number, (int, float)):
        raise TypeError(f"JCS: cannot serialize a {type(number).__name__}")
    if isinstance(number, int):
        return "0" if number == 0 else str(number)
    if not math.isfinite(number):
        raise TypeError(f"JCS: non-finite number {number}")
    if number == 0.0:
        return "0"
    sign = "-" if number < 0 else ""
    absolute = abs(number)
    raw = json.dumps(absolute)
    if "e" in raw or "E" in raw:
        mantissa, exponent_text = raw.lower().split("e")
        exponent = int(exponent_text)
        if absolute >= 1e21 or absolute < 1e-6:
            if mantissa.endswith(".0"):
                mantissa = mantissa[:-2]
            exponent_sign = "+" if exponent >= 0 else "-"
            return f"{sign}{mantissa}e{exponent_sign}{abs(exponent)}"
        if "." in mantissa:
            whole, frac = mantissa.split(".")
        else:
            whole, frac = mantissa, ""
        digits = whole + frac
        point = len(whole) + exponent
        if point <= 0:
            return sign + "0." + ("0" * (-point)) + digits
        if point >= len(digits):
            return sign + digits + ("0" * (point - len(digits)))
        return sign + digits[:point] + "." + digits[point:]
    if raw.endswith(".0"):
        raw = raw[:-2]
    return sign + raw


def _dump_string(text: str) -> str:
    # JSON.stringify keeps non-ASCII and escapes U+2028 / U+2029.
    dumped = json.dumps(text, ensure_ascii=False)
    return dumped.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def canonicalize(value: Any) -> str:
    """Canonical JSON. Raises TypeError for values JSON cannot carry."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return _es_number(value)
    if isinstance(value, float):
        return _es_number(value)
    if isinstance(value, str):
        return _dump_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        parts: list[str] = []
        for key in sorted(value.keys(), key=lambda item: str(item).encode("utf-16-be")):
            if not isinstance(key, str):
                raise TypeError("JCS: object keys must be strings")
            parts.append(_dump_string(key) + ":" + canonicalize(value[key]))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"JCS: cannot serialize a {type(value).__name__}")


def _sanitize(value: Any) -> Any:
    """What JSON.stringify then JSON.parse yields for a Python value."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or value == 0.0:
            return None if not math.isfinite(value) else 0
        return value
    if isinstance(value, datetime):
        moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        moment = moment.astimezone(timezone.utc)
        return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"
    if isinstance(value, dict):
        return {str(key): _sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    # Dates and odd objects: one JSON round trip, like JSON.stringify.
    try:
        text = json.dumps(value)
    except (TypeError, ValueError):
        return None
    if text is None:
        return None
    return json.loads(text)


def json_value(value: Any) -> Any:
    """The value the other side of a JSON request sees.

    Missing values become null. Non-finite numbers become null. Hash this,
    never the raw in-memory object.
    """
    if value is None:
        return None
    return _sanitize(value)
