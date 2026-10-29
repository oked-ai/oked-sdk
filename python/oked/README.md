# oked

Human approval for Python agents. Send a sensitive action to OKed, wait for a person, and continue only when they approve.

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. [Sign up](https://oked.ai/signup) to get an API key. Questions: [contact@oked.ai](mailto:contact@oked.ai).

For LangGraph and LangChain tools, install [`oked-langgraph`](../oked-langgraph) instead of calling `approve` yourself.

## Install

```bash
pip install oked
```

Python 3.9 or newer. Set a key before the process starts:

```bash
export OKED_API_KEY=ok_...
```

Create a key from the [dashboard](https://oked.ai/dashboard). A key in `~/.oked/config.json` (`{ "apiKey": "ok_..." }`) works when the environment variable is unset. `oked init --key-only` from `@oked/claude-code` writes that file.

## Quick start

```python
from oked import OkedClient

oked = OkedClient()  # OKED_API_KEY, or ~/.oked/config.json

result = oked.approve({
    "action": "create_payment",
    "description": "Transfer 2,400 EUR to vendor@example.com",
    "tier": "high_stakes",
})

if not result.approved:
    raise SystemExit(f"Blocked by OKed: {result.decision}")
```

`approve_async` is the same call for async code. The approval window is 10 minutes. The client waits 630 seconds (`DEFAULT_APPROVAL_TIMEOUT_MS`), 30 seconds past that window, so the backend's `timeout` answer arrives before the client gives up. A timeout is a denial (`decision == "timeout"`, `approved` is false).

`result.receipt` is the signed receipt when the backend sent one, already checked against the action you sent.

## When something fails

An explicit denial returns `approved=False` and is final. An invalid API key raises `OkedAuthError`. A receipt that does not verify, or an approval with no receipt, raises `OkedReceiptError`. HTTP 429 raises `OkedTooManyPendingError` (too many approvals are already waiting in Telegram or on the dashboard). Other HTTP errors raise `OkedHttpError`.

If the backend cannot be reached, `approve` raises `OkedBackendUnreachableError`. That is the outage signal. `high_stakes` should be denied. Lower tiers may proceed unless `OKED_STRICT_FAIL_CLOSED=1` (or `strict_fail_closed=True`), which denies every sensitive action during an outage. `degraded_decision(tier, strict_fail_closed=...)` applies that rule. A request the backend accepted and nobody answered is `decision="timeout"`, not an outage.

Set `OKED_REQUIRE_RECEIPT=0` only for a backend that does not sign receipts. Receipts are checked by default.

## Risk tiers

`safe`, `warning`, `review`, and `high_stakes`. `classify(tool_name, tool_input)` returns a tier. Unknown tool names are `review`. A string `command` or `cmd` is classified as a shell command. A path plus a content string is a file write: `warning`, or `review` on a sensitive path.

`apply_rules` evaluates user rules. The first match wins. Rules match kind, title, target, body, and the working directory.

## Package

Version `0.6.21`, the same number as the `@oked/*` packages in this repo. The PyPI name is `oked`. The first publish is by hand. Later publishes use a `py-v*` tag. See [RELEASING.md](../../RELEASING.md).

## License

[Apache-2.0](./LICENSE).
