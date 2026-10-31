"""OKed for Python. Human approval before a risky agent action runs."""

from oked.classify import classify, classify_shell, is_sensitive_write_path
from oked.client import DEFAULT_APPROVAL_TIMEOUT_MS, OkedClient
from oked.config import load_oked_config
from oked.degraded import TIER_ORDER, degraded_decision
from oked.describe import describe, describe_fields, lookup_pr_title
from oked.errors import (
    OkedAuthError,
    OkedBackendUnreachableError,
    OkedError,
    OkedHttpError,
    OkedReceiptError,
    OkedTooManyPendingError,
)
from oked.jcs import canonicalize, json_value
from oked.receipt import (
    OKED_RECEIPT_KEYS_URL,
    PINNED_RECEIPT_KEYS,
    body_digest,
    check_receipt,
    keys_url_allowed,
    public_key_from_seed,
    short_receipt_id,
    sign_body,
    subject_digest,
    verify_receipt,
)
from oked.rules import Rule, RuleDecision, apply_rules
from oked.types import ApprovalRequest, ApprovalResponse, RiskTier
from oked.watch import effective_mode, parse_mode, resolve_mode

__version__ = "0.6.21"

__all__ = [
    "DEFAULT_APPROVAL_TIMEOUT_MS",
    "OKED_RECEIPT_KEYS_URL",
    "PINNED_RECEIPT_KEYS",
    "TIER_ORDER",
    "ApprovalRequest",
    "ApprovalResponse",
    "OkedAuthError",
    "OkedBackendUnreachableError",
    "OkedClient",
    "OkedError",
    "OkedHttpError",
    "OkedReceiptError",
    "OkedTooManyPendingError",
    "RiskTier",
    "Rule",
    "RuleDecision",
    "__version__",
    "apply_rules",
    "body_digest",
    "canonicalize",
    "check_receipt",
    "classify",
    "classify_shell",
    "degraded_decision",
    "describe",
    "describe_fields",
    "effective_mode",
    "parse_mode",
    "resolve_mode",
    "is_sensitive_write_path",
    "json_value",
    "keys_url_allowed",
    "load_oked_config",
    "lookup_pr_title",
    "public_key_from_seed",
    "short_receipt_id",
    "sign_body",
    "subject_digest",
    "verify_receipt",
]
