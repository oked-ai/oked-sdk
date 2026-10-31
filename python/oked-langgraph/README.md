# oked-langgraph

Python package for [LangGraph](https://github.com/langchain-ai/langgraph) and LangChain tools. This is the Python integration, not the Node.js `@oked/langgraph` package. Wrap a tool, and a risky call waits for a person in Telegram or on the [web dashboard](https://oked.ai/dashboard) before it runs. The iPhone app is coming soon.

`with_oked_approval` wraps one tool. `with_oked_approvals` wraps a list. Pass that list to `ToolNode` or `create_react_agent`. A denial, a timeout, or a failed approval does not run the tool. The model gets a result that says the action was not run and not to retry it.

This is the Python counterpart of [`@oked/langgraph`](../../packages/langgraph). The receipt subject uses `source` `langgraph` in both. The Python client string is `oked-langgraph-py@<version>`.

Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Install

Not on PyPI yet. Until then, install both packages from this repo. `oked-langgraph` pins `oked==0.6.21`, and that package is not on PyPI either:

```bash
pip install "oked @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked" "oked-langgraph @ git+https://github.com/oked-ai/oked-sdk#subdirectory=python/oked-langgraph"
```

Once it is on PyPI, the command is `pip install oked-langgraph`. That also installs `oked`.

Python 3.10 or newer, because current LangChain and LangGraph require 3.10. The core `oked` package still runs on Python 3.9.

`langgraph` is not installed for you. Install it if you use `ToolNode` or `create_react_agent`. You already have it if you are building a LangGraph agent.

```bash
export OKED_API_KEY=ok_...
```

Create a key from the [dashboard](https://oked.ai/dashboard) after you [sign up](https://oked.ai/signup). A key in `~/.oked/config.json` works when the environment variable is unset.

## Quick start

```python
from langgraph.prebuilt import create_react_agent
from oked_langgraph import with_oked_approvals

agent = create_react_agent(
    llm,
    with_oked_approvals([search_docs, send_email, refund_order]),
)
```

One tool:

```python
from oked_langgraph import with_oked_approval

send_email = with_oked_approval(raw_send_email, tier="high_stakes")
```

A tool node:

```python
from langgraph.prebuilt import ToolNode
from oked_langgraph import with_oked_approvals

tool_node = ToolNode(
    with_oked_approvals(
        [search_docs, send_email],
        always_approve=["send_email"],
        always_allow=["search_docs"],
    )
)
```

`name`, `description`, and `args_schema` stay the same, so `bind_tools` still sees the original tool. `invoke` and `ainvoke` are gated. On an approval, that call is forwarded with the same arguments and the same config. `configurable.thread_id` is the approval session unless you set `session_id`.

LangGraph 1.0 also offers `create_agent` from the `langchain` package. Pass the wrapped list the same way.

## Why this is not interrupt()

LangGraph's `interrupt()`, and `interrupt_before` / `interrupt_after`, pause the graph until the code that invoked the graph resumes it. That person is whoever is driving the process. They need a checkpointer, and a resume that skips the check runs the tool.

OKed's person is on Telegram or the web dashboard. `approve()` already waits for them (10 minutes on the server, 630 seconds in the client). Doing that wait inside the tool means:

- `ToolNode` and `create_react_agent` do not need a checkpointer or a resume step.
- A denial cannot be skipped by resuming the graph.
- One denied call does not cancel a sibling tool call in the same turn.
- The model receives a tool result either way, so the turn can continue.

The process has to stay up for the wait. Allow at least 630 seconds for a gated call. `timeout_ms` changes the client wait. A timeout is a denial, not an outage.

`gate_tool_call` is the same decision without wrapping, for a node you wrote yourself. Run the tool only when `run` is true. Otherwise return `message` to the model and do not call the tool. `gate_tool_call_async` is the async form.

```python
from langchain_core.messages import ToolMessage
from oked_langgraph import gate_tool_call

gate = gate_tool_call(call["name"], call["args"], config=config)
if not gate["run"]:
    return ToolMessage(content=gate["message"], tool_call_id=call["id"], status="error")
```

## Behavior

Unknown tool names are `review` unless you set `tier`, `always_allow`, or `min_tier`. A tool with a string `command` or `cmd` is classified as a shell command. A tool with a path and a content string is a file write.

| Tier | What happens |
|---|---|
| `safe` | Runs immediately. No approval request, unless a cached user rule matches. |
| `warning` | Runs, and logs a line to stderr. No approval request, unless a cached user rule matches. |
| `review` / `high_stakes` | Waits for a person. Approve, and the tool runs with the original arguments. Otherwise it does not run, and the model is told not to retry. |

| What happened | Result |
|---|---|
| Person denies | Tool does not run. |
| Approval window expires (`timeout`) | Tool does not run. A client-side abort is the same denial, not an outage. |
| No API key | Tool does not run. |
| Invalid API key, bad receipt, HTTP 429, other HTTP error, unexpected error | Tool does not run. |
| Backend unreachable, tier `high_stakes` | Tool does not run. |
| Backend unreachable, lower tier | Tool runs, unless `OKED_STRICT_FAIL_CLOSED=1` (or `strict_fail_closed=True`), which denies every sensitive call during an outage. |

`ToolNode` receives a denial as a `ToolMessage` with `status="error"`. Throwing would let `ToolNode` replace the reason with "Please fix your mistakes".

`min_tier` is the lowest tier that waits. The default is `review`, so `safe` and `warning` run. `OKED_MIN_TIER` is used when `min_tier` is omitted. `warning` does not wait on tier alone. `always_approve` is a list of exact tool names that always wait, at `high_stakes`. `always_allow` is a list of exact tool names that never wait.

A cached user rule can send a `safe` or `warning` call to the backend, which applies the rule and signs the receipt. Edit rules in Telegram (Rule on the card) or on the dashboard (the gear on a card, or Rules).

## Options

| Option | Role |
|---|---|
| `api_key` | Overrides `OKED_API_KEY` and `~/.oked/config.json`. |
| `timeout_ms` | Client wait, in milliseconds. Default 630000. |
| `strict_fail_closed` | Deny every sensitive call when the backend is unreachable. |
| `min_tier` | Lowest tier that waits. Default `review`. |
| `mode` | `watch` lets a risky call run and records that it would have paused. Default `enforce`. `OKED_MODE` is the fallback. See [docs/watch.md](../../docs/watch.md). |
| `always_approve` | Exact tool names that always wait, at `high_stakes`. |
| `always_allow` | Exact tool names that never wait. |
| `tier` | Use this tier instead of the classifier. `always_allow` and `always_approve` still win. |
| `session_id` | Stored on the approval. Wins over `config["configurable"]["thread_id"]`. |
| `cwd` | Stored on the approval. Default is the process working directory. |
| `client` | An existing `OkedClient`, or a test double with `approve`, `get_rules`, `heartbeat`, `api_key`, and `strict_fail_closed`. |

`create_oked_client()` builds the client the wrappers use.

## License

[Apache-2.0](./LICENSE).
