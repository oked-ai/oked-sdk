"""Receipt canonicalization and verification against the shared vectors."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from oked import canonicalize, json_value, subject_digest, verify_receipt
from oked.jcs import canonicalize as jcs_canonicalize
from oked.receipt import public_key_from_seed, sign_body

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / "packages" / "receipt-core" / "test" / "vectors"


def test_jcs_vectors_match_receipt_core() -> None:
    rows = json.loads((VECTORS / "jcs.json").read_text(encoding="utf-8"))
    for row in rows:
        assert jcs_canonicalize(json.loads(row["input"])) == row["canonical"]


def test_canonicalize_rejects_non_finite_numbers() -> None:
    with pytest.raises(TypeError):
        canonicalize(float("nan"))
    with pytest.raises(TypeError):
        canonicalize(float("inf"))


def test_json_value_matches_a_json_round_trip() -> None:
    assert json_value(None) is None
    assert json_value({"a": 1, "c": [None]}) == {"a": 1, "c": [None]}


def test_golden_receipt_verifies() -> None:
    golden = json.loads((VECTORS / "receipt-v1.json").read_text(encoding="utf-8"))
    key = {
        "kid": golden["key"]["kid"],
        "alg": "Ed25519",
        "public_key": golden["key"]["public_key"],
        "not_before": golden["key"]["not_before"],
        "not_after": golden["key"]["not_after"],
    }
    assert public_key_from_seed(golden["key"]["seed"]) == golden["key"]["public_key"]
    assert canonicalize(golden["subject"]) == golden["subject_jcs"]
    assert subject_digest(golden["subject"]) == golden["subject_digest"]
    first = golden["receipts"][0]["envelope"]
    assert canonicalize(first["body"]) == golden["receipts"][0]["body_jcs"]
    signed = sign_body(first["body"], golden["key"]["seed"], golden["key"]["kid"])
    assert signed["sig"] == first["sig"]
    check = verify_receipt(first, keys={"keys": [key]}, subject=golden["subject"])
    assert check["ok"] is True
    assert check["problems"] == []
    tampered = json.loads(json.dumps(first))
    tampered["body"]["decision"] = "denied"
    assert "bad_signature" in verify_receipt(tampered, keys=[key])["problems"]
