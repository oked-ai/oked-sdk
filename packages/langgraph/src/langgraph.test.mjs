// Unit tests for @oked/langgraph. approve() is mocked. One real-client
// timeout test mocks fetch so a hung request becomes a denial, not a run.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node 18 ESM does not define the Web Crypto global. LangGraph 1.5's tracer
// calls it. Node 22 already defines it.
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = webcrypto;
}

process.env.HOME = mkdtempSync(join(tmpdir(), "oked-langgraph-"));
process.env.USERPROFILE = process.env.HOME;
delete process.env.OKED_API_KEY;
delete process.env.OKED_MIN_TIER;
delete process.env.OKED_STRICT_FAIL_CLOSED;
delete process.env.OKED_REQUIRE_RECEIPT;

const { createOkedClient, gateToolCall, withOkedApproval, withOkedApprovals } = await import("../dist/index.js");
const {
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
} = await import("@oked/sdk");

const ALLOWED = { approved: true, approval_id: "ap_ok", decision: "approved" };
const DENIED = { approved: false, approval_id: "ap_no", decision: "denied" };
const TIMED_OUT = { approved: false, approval_id: null, decision: "timeout" };

function fakeClient(overrides = {}) {
  const client = {
    apiKey: overrides.apiKey ?? "ok_test",
    strictFailClosed: overrides.strictFailClosed ?? false,
    heartbeats: 0,
    calls: [],
    rules: overrides.rules ?? [],
    rulesError: overrides.rulesError ?? null,
    approveResult: overrides.approveResult ?? ALLOWED,
    approveError: overrides.approveError ?? null,
    heartbeatError: overrides.heartbeatError ?? null,
    async heartbeat() {
      if (client.heartbeatError) throw client.heartbeatError;
      client.heartbeats += 1;
    },
    async getRules() {
      if (client.rulesError) throw client.rulesError;
      return client.rules;
    },
    async approve(request) {
      client.calls.push(request);
      if (client.approveError) throw client.approveError;
      return typeof client.approveResult === "function" ? client.approveResult(request) : client.approveResult;
    },
  };
  return client;
}

function toolCall(name, args, id = "call_1") {
  return { type: "tool_call", id, name, args };
}

function recordingTool(name, extra = {}) {
  const seen = [];
  const tool = {
    name,
    description: extra.description ?? `${name} tool`,
    async invoke(input, config) {
      seen.push({ input, config, via: "invoke" });
      if (extra.fail) throw extra.fail;
      return extra.result ?? "ran";
    },
    ...extra.members,
  };
  return { tool, seen };
}

const tests = [];
function check(name, fn) {
  tests.push([name, fn]);
}

check("approved call forwards the same input and config", async () => {
  const client = fakeClient();
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client, cwd: "/srv/app" });
  const input = toolCall("send_invoice", { amount: 2400, currency: "EUR", to: "vendor@example.com" });
  const config = { configurable: { thread_id: "thread-9" }, tags: ["agent"] };
  const result = await wrapped.invoke(input, config);
  assert.equal(result, "ran");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, input);
  assert.equal(seen[0].config, config);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].action, "send_invoice");
  assert.equal(client.calls[0].tier, "review");
  assert.equal(client.calls[0].tool_input, input.args);
  assert.equal(client.calls[0].session_id, "thread-9");
  assert.equal(client.calls[0].cwd, "/srv/app");
  assert.equal(client.heartbeats, 1);
  assert.ok(client.calls[0].description);
  assert.equal(client.calls[0].fields.Title, "send_invoice");
});

check("sessionId wins over thread_id", async () => {
  const client = fakeClient();
  const { tool } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client, sessionId: "explicit" });
  await wrapped.invoke(toolCall("send_invoice", { amount: 1 }), {
    configurable: { thread_id: "thread", session_id: "other" },
  });
  assert.equal(client.calls[0].session_id, "explicit");
});

check("denied approval does not run the tool and returns an error ToolMessage", async () => {
  const logs = [];
  const client = fakeClient({ approveResult: DENIED });
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client, log: (m) => logs.push(m) });
  const result = await wrapped.invoke(toolCall("send_invoice", { amount: 5 }, "call_deny"));
  assert.equal(seen.length, 0);
  assert.equal(result.status, "error");
  assert.equal(result.tool_call_id, "call_deny");
  assert.equal(result.name, "send_invoice");
  assert.match(String(result.content), /USER DENIED send_invoice via OKed \(approval ap_no\)/);
  assert.match(String(result.content), /This action was not run/);
  assert.match(String(result.content), /Do NOT retry/);
  assert.ok(logs.some((line) => line.includes("Requesting approval")));
  assert.ok(logs.some((line) => line.includes("Denied (ap_no)")));
});

check("raw invoke on deny returns a string and does not run the tool", async () => {
  const client = fakeClient({ approveResult: DENIED });
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client });
  const result = await wrapped.invoke({ amount: 5 });
  assert.equal(seen.length, 0);
  assert.equal(typeof result, "string");
  assert.match(result, /DENIED/);
  assert.match(result, /was not run/);
});

check("timeout with no approval id does not run the tool", async () => {
  const client = fakeClient({ approveResult: TIMED_OUT });
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client });
  const result = await wrapped.invoke(toolCall("send_invoice", { amount: 1 }));
  assert.equal(seen.length, 0);
  assert.equal(result.status, "error");
  assert.match(String(result.content), /did not respond/);
  assert.match(String(result.content), /approval window expired/);
  assert.doesNotMatch(String(result.content), /approval null/);
  assert.match(String(result.content), /was not run/);
});

check("timeout with an approval id names that id and does not run the tool", async () => {
  const client = fakeClient({
    approveResult: { approved: false, approval_id: "ap_to", decision: "timeout" },
  });
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client });
  const result = await wrapped.invoke(toolCall("send_invoice", { amount: 1 }));
  assert.equal(seen.length, 0);
  assert.match(String(result.content), /approval ap_to/);
  assert.match(String(result.content), /did not respond/);
});

check("receipt, auth, http, pending, and unexpected errors do not run the tool", async () => {
  const cases = [
    [new OKedReceiptError("bad signature", ["bad_signature"]), /did not verify/],
    [new OKedAuthError("nope", 401), /invalid API key/],
    [new OKedHttpError(400, "bad request"), /HTTP 400/],
    [new OKedTooManyPendingError("queue full"), /429/],
    [new Error("socket hangup"), /unexpected error/],
  ];
  for (const [err, pattern] of cases) {
    const client = fakeClient({ approveError: err });
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { client });
    const result = await wrapped.invoke(toolCall("send_invoice", { amount: 1 }));
    assert.equal(seen.length, 0, err.name);
    assert.equal(result.status, "error");
    assert.match(String(result.content), pattern);
    assert.match(String(result.content), /was not run/);
    assert.match(String(result.content), /Do NOT retry/);
  }
});

check("unreachable backend denies high_stakes and allows review unless strict", async () => {
  const outage = new OKedBackendUnreachableError("connect refused");
  {
    const logs = [];
    const client = fakeClient({ approveError: outage });
    const { tool, seen } = recordingTool("shell");
    const wrapped = withOkedApproval(tool, { client, log: (m) => logs.push(m) });
    const result = await wrapped.invoke(toolCall("shell", { command: "rm -rf ./src" }));
    assert.equal(client.calls[0].tier, "high_stakes");
    assert.equal(seen.length, 0);
    assert.match(String(result.content), /high_stakes/);
    assert.match(String(result.content), /was not run/);
    assert.ok(logs.some((line) => line.includes("fail-safe")));
  }
  {
    const client = fakeClient({ approveError: outage });
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { client });
    const result = await wrapped.invoke(toolCall("send_invoice", { amount: 1 }));
    assert.equal(client.calls[0].tier, "review");
    assert.equal(result, "ran");
    assert.equal(seen.length, 1);
  }
  {
    const client = fakeClient({ approveError: outage, strictFailClosed: true });
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { client });
    const result = await wrapped.invoke(toolCall("send_invoice", { amount: 1 }));
    assert.equal(seen.length, 0);
    assert.match(String(result.content), /strict fail-closed/);
  }
});

check("a tool error after approval propagates and is not turned into a denial", async () => {
  const client = fakeClient();
  const { tool } = recordingTool("send_invoice", { fail: new Error("smtp down") });
  const wrapped = withOkedApproval(tool, { client });
  await assert.rejects(() => wrapped.invoke(toolCall("send_invoice", { amount: 1 })), /smtp down/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].tool_input.amount, 1);
});

check("safe and warning tools run without approve; a sensitive write asks", async () => {
  const client = fakeClient({ approveResult: DENIED });
  const logs = [];
  const safe = recordingTool("list_files");
  const safeWrapped = withOkedApproval(safe.tool, { client, log: (m) => logs.push(m) });
  assert.equal(await safeWrapped.invoke(toolCall("list_files", {})), "ran");
  assert.equal(client.calls.length, 0);
  assert.equal(safe.seen.length, 1);

  const warning = recordingTool("write_note");
  const warningWrapped = withOkedApproval(warning.tool, { client, log: (m) => logs.push(m) });
  assert.equal(
    await warningWrapped.invoke(toolCall("write_note", { path: "/tmp/note.txt", content: "hello" })),
    "ran",
  );
  assert.equal(client.calls.length, 0);
  assert.ok(logs.some((line) => line.includes("WARNING") && line.includes("write_note")));

  const sensitive = recordingTool("write_note");
  const sensitiveWrapped = withOkedApproval(sensitive.tool, { client });
  const denied = await sensitiveWrapped.invoke(
    toolCall("write_note", { path: "/etc/hosts", content: "x" }),
  );
  assert.equal(sensitive.seen.length, 0);
  assert.match(String(denied.content), /DENIED/);
  assert.equal(client.calls[0].tier, "review");
});

check("missing API key denies a sensitive tool and does not call approve", async () => {
  const client = fakeClient({ apiKey: "" });
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client });
  const result = await wrapped.invoke({ amount: 9 });
  assert.equal(seen.length, 0);
  assert.equal(client.calls.length, 0);
  assert.match(result, /no API key/);
  assert.match(result, /OKED_API_KEY/);
  assert.match(result, /was not run/);
});

check("minTier high_stakes lets a review tool run and still gates a destructive shell", async () => {
  const client = fakeClient({ approveResult: DENIED });
  const review = recordingTool("send_invoice");
  const reviewWrapped = withOkedApproval(review.tool, { client, minTier: "high_stakes" });
  assert.equal(await reviewWrapped.invoke(toolCall("send_invoice", { amount: 1 })), "ran");
  assert.equal(client.calls.length, 0);

  const shell = recordingTool("shell");
  const shellWrapped = withOkedApproval(shell.tool, { client, minTier: "high_stakes" });
  const denied = await shellWrapped.invoke(toolCall("shell", { command: "rm -rf ./src" }));
  assert.equal(shell.seen.length, 0);
  assert.match(String(denied.content), /DENIED/);
  assert.equal(client.calls[0].tier, "high_stakes");
  assert.equal(client.calls[0].tool_input.command, "rm -rf ./src");
});

check("OKED_MIN_TIER is used when minTier is omitted", async () => {
  const prev = process.env.OKED_MIN_TIER;
  process.env.OKED_MIN_TIER = "high_stakes";
  try {
    const client = fakeClient({ approveResult: DENIED });
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { client });
    assert.equal(await wrapped.invoke(toolCall("send_invoice", { amount: 1 })), "ran");
    assert.equal(seen.length, 1);
    assert.equal(client.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OKED_MIN_TIER;
    else process.env.OKED_MIN_TIER = prev;
  }
});

check("alwaysAllow skips approval and alwaysApprove forces high_stakes", async () => {
  const client = fakeClient({ approveResult: DENIED });
  const shell = recordingTool("shell");
  const allowed = withOkedApproval(shell.tool, { client, alwaysAllow: ["shell"] });
  assert.equal(await allowed.invoke(toolCall("shell", { command: "rm -rf ./src" })), "ran");
  assert.equal(shell.seen.length, 1);
  assert.equal(client.calls.length, 0);

  const listed = recordingTool("list_files");
  const forced = withOkedApproval(listed.tool, { client, alwaysApprove: ["list_files"] });
  const denied = await forced.invoke(toolCall("list_files", {}));
  assert.equal(listed.seen.length, 0);
  assert.match(String(denied.content), /DENIED/);
  assert.equal(client.calls[0].tier, "high_stakes");
});

check("tier override replaces the classifier", async () => {
  const client = fakeClient({ approveResult: DENIED });
  const writer = recordingTool("write_note");
  const forced = withOkedApproval(writer.tool, { client, tier: "high_stakes" });
  await forced.invoke(toolCall("write_note", { path: "/tmp/note.txt", content: "hi" }));
  assert.equal(writer.seen.length, 0);
  assert.equal(client.calls[0].tier, "high_stakes");

  const shell = recordingTool("shell");
  const quiet = withOkedApproval(shell.tool, { client, tier: "safe" });
  assert.equal(await quiet.invoke(toolCall("shell", { command: "rm -rf ./src" })), "ran");
  assert.equal(shell.seen.length, 1);
});

check("a matching cached rule escalates a safe tool; a miss or a rules error does not", async () => {
  const matching = [
    { id: "rule_1", match: { title: { op: "equals", value: "list_files" } }, action: "auto_deny" },
  ];
  const hit = fakeClient({ rules: matching, approveResult: DENIED });
  const listed = recordingTool("list_files");
  const wrapped = withOkedApproval(listed.tool, { client: hit });
  const denied = await wrapped.invoke(toolCall("list_files", {}));
  assert.equal(listed.seen.length, 0);
  assert.match(String(denied.content), /DENIED/);
  assert.equal(hit.calls.length, 1);

  const miss = fakeClient({
    rules: [{ id: "rule_2", match: { title: { op: "equals", value: "other" } }, action: "auto_deny" }],
    approveResult: DENIED,
  });
  const listed2 = recordingTool("list_files");
  const wrapped2 = withOkedApproval(listed2.tool, { client: miss });
  assert.equal(await wrapped2.invoke(toolCall("list_files", {})), "ran");
  assert.equal(miss.calls.length, 0);

  const broken = fakeClient({ rulesError: new Error("rules down"), approveResult: DENIED });
  const listed3 = recordingTool("list_files");
  const wrapped3 = withOkedApproval(listed3.tool, { client: broken });
  assert.equal(await wrapped3.invoke(toolCall("list_files", {})), "ran");
  assert.equal(broken.calls.length, 0);
});

check("a heartbeat failure does not block an approval", async () => {
  const client = fakeClient({ heartbeatError: new Error("disk full") });
  const { tool, seen } = recordingTool("send_invoice");
  const wrapped = withOkedApproval(tool, { client });
  assert.equal(await wrapped.invoke(toolCall("send_invoice", { amount: 1 })), "ran");
  assert.equal(seen.length, 1);
  assert.equal(client.calls.length, 1);
});

check("invoke keeps the original tool as this", async () => {
  const client = fakeClient();
  const tool = {
    name: "send_invoice",
    secret: "s",
    async invoke() {
      if (this.secret !== "s") throw new Error("bad this");
      return "ok";
    },
  };
  const wrapped = withOkedApproval(tool, { client });
  assert.equal(await wrapped.invoke(toolCall("send_invoice", { amount: 1 })), "ok");
});

check("call and func are gated, and batch gates each input", async () => {
  const hits = [];
  const tool = {
    name: "send_invoice",
    async invoke(input) {
      hits.push(["invoke", input]);
      return "invoked";
    },
    async call(input) {
      hits.push(["call", input]);
      return "called";
    },
    async func(input) {
      hits.push(["func", input]);
      return "funced";
    },
    async batch(inputs) {
      hits.push(["batch", inputs]);
      return inputs.map(() => "batched");
    },
  };
  const denied = withOkedApproval(tool, { client: fakeClient({ approveResult: DENIED }) });
  const callResult = await denied.call(toolCall("send_invoice", { amount: 1 }, "c_call"));
  assert.equal(hits.length, 0);
  assert.equal(callResult.status, "error");
  const funcResult = await denied.func({ amount: 2 });
  assert.equal(hits.length, 0);
  assert.match(funcResult, /DENIED/);
  const batched = await denied.batch([{ amount: 3 }, { amount: 4 }]);
  assert.equal(hits.length, 0);
  assert.equal(batched.length, 2);
  assert.match(batched[0], /was not run/);

  hits.length = 0;
  const client = fakeClient();
  const allowed = withOkedApproval(tool, { client });
  assert.equal(await allowed.func({ amount: 8 }, undefined, { configurable: { thread_id: "from-func" } }), "funced");
  assert.deepEqual(hits[0], ["func", { amount: 8 }]);
  assert.equal(client.calls[0].session_id, "from-func");
  assert.equal(client.calls[0].tool_input.amount, 8);
  const batchOut = await allowed.batch([toolCall("send_invoice", { amount: 9 }, "b1")]);
  assert.equal(batchOut.length, 1);
  assert.equal(hits.some((hit) => hit[0] === "invoke"), true);
  assert.equal(hits.some((hit) => hit[0] === "batch"), false);
});

check("withOkedApprovals shares a client and does not double wrap", async () => {
  const client = fakeClient({
    approveResult: (request) =>
      request.action === "create_invoice"
        ? ALLOWED
        : DENIED,
  });
  const invoice = recordingTool("create_invoice");
  const email = recordingTool("send_email");
  const [wrappedInvoice, wrappedEmail] = withOkedApprovals([invoice.tool, email.tool], { client });
  assert.equal(await wrappedInvoice.invoke(toolCall("create_invoice", { amount: 10 }, "a")), "ran");
  const denied = await wrappedEmail.invoke(toolCall("send_email", { to: "a@example.com" }, "b"));
  assert.equal(invoice.seen.length, 1);
  assert.equal(invoice.seen[0].input.args.amount, 10);
  assert.equal(email.seen.length, 0);
  assert.match(String(denied.content), /DENIED/);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(
    client.calls.map((call) => call.action),
    ["create_invoice", "send_email"],
  );

  const other = fakeClient({ approveResult: DENIED });
  const again = withOkedApproval(wrappedInvoice, { client: other });
  assert.equal(again, wrappedInvoice);
  await again.invoke(toolCall("create_invoice", { amount: 1 }));
  assert.equal(other.calls.length, 0);
  assert.equal(client.calls.length, 3);
});

check("invalid tools throw before any call", async () => {
  assert.throws(() => withOkedApproval(null), /LangChain tool/);
  assert.throws(() => withOkedApproval({ name: "", invoke() {} }), /name/);
  assert.throws(() => withOkedApproval({ name: "x" }), /invoke/);
  assert.throws(() => withOkedApprovals("nope"), /array/);
  assert.deepEqual(withOkedApprovals([]), []);
});

check("gateToolCall is the decision a custom node can branch on", async () => {
  const denied = await gateToolCall("send_invoice", { amount: 3 }, {
    client: fakeClient({ approveResult: DENIED }),
  });
  assert.equal(denied.run, false);
  assert.equal(denied.decision, "denied");
  assert.equal(denied.approvalId, "ap_no");
  assert.match(denied.message, /was not run/);

  const allowed = await gateToolCall("send_invoice", { amount: 4 }, { client: fakeClient() });
  assert.equal(allowed.run, true);
  assert.equal(allowed.decision, "approved");
  assert.equal(allowed.tier, "review");

  const timed = await gateToolCall("send_invoice", { amount: 5 }, {
    client: fakeClient({ approveResult: TIMED_OUT }),
  });
  assert.equal(timed.run, false);
  assert.equal(timed.decision, "timeout");
});

check("createOkedClient reads the API key and strict flag", async () => {
  const prevKey = process.env.OKED_API_KEY;
  const prevStrict = process.env.OKED_STRICT_FAIL_CLOSED;
  try {
    process.env.OKED_API_KEY = "ok_from_env";
    delete process.env.OKED_STRICT_FAIL_CLOSED;
    const fromEnv = createOkedClient();
    assert.equal(fromEnv.apiKey, "ok_from_env");
    assert.equal(fromEnv.strictFailClosed, false);
    const explicit = createOkedClient({ apiKey: "ok_explicit", strictFailClosed: true });
    assert.equal(explicit.apiKey, "ok_explicit");
    assert.equal(explicit.strictFailClosed, true);
    process.env.OKED_STRICT_FAIL_CLOSED = "1";
    assert.equal(createOkedClient().strictFailClosed, true);
    assert.equal(createOkedClient({ strictFailClosed: false }).strictFailClosed, false);
  } finally {
    if (prevKey === undefined) delete process.env.OKED_API_KEY;
    else process.env.OKED_API_KEY = prevKey;
    if (prevStrict === undefined) delete process.env.OKED_STRICT_FAIL_CLOSED;
    else process.env.OKED_STRICT_FAIL_CLOSED = prevStrict;
  }
});

check("no API key does not touch the network", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("network");
  };
  try {
    delete process.env.OKED_API_KEY;
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { tier: "high_stakes" });
    const result = await wrapped.invoke({ amount: 1 });
    assert.equal(seen.length, 0);
    assert.equal(fetches, 0);
    assert.match(result, /no API key/);
  } finally {
    globalThis.fetch = original;
  }
});

check("a client-side timeout from fetch is a denial, not a run", async () => {
  const original = globalThis.fetch;
  const prevKey = process.env.OKED_API_KEY;
  process.env.OKED_API_KEY = "ok_test";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes("/api/v1/approve")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    // AbortSignal.timeout() does not keep the process alive by itself. Hold a
    // ref'd timer so the test stays up until that abort fires.
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => {
        reject(new Error("approval abort did not fire"));
      }, 2000);
      const abort = () => {
        clearTimeout(keepAlive);
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        reject(err);
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  try {
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { timeoutMs: 40, tier: "high_stakes" });
    const result = await wrapped.invoke(toolCall("send_invoice", { amount: 1 }));
    assert.equal(seen.length, 0);
    assert.equal(result.status, "error");
    assert.match(String(result.content), /did not respond/);
    assert.match(String(result.content), /was not run/);
  } finally {
    globalThis.fetch = original;
    if (prevKey === undefined) delete process.env.OKED_API_KEY;
    else process.env.OKED_API_KEY = prevKey;
  }
});

check("an HTTP 401 from the real client denies and does not run the tool", async () => {
  const original = globalThis.fetch;
  const prevKey = process.env.OKED_API_KEY;
  process.env.OKED_API_KEY = "ok_test";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("/api/v1/approve")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { tool, seen } = recordingTool("send_invoice");
    const wrapped = withOkedApproval(tool, { tier: "high_stakes" });
    const result = await wrapped.invoke(toolCall("send_invoice", { amount: 2 }));
    assert.equal(seen.length, 0);
    assert.match(String(result.content), /invalid API key/);
    assert.match(String(result.content), /was not run/);
  } finally {
    globalThis.fetch = original;
    if (prevKey === undefined) delete process.env.OKED_API_KEY;
    else process.env.OKED_API_KEY = prevKey;
  }
});

check("ToolNode runs only the approved tool and preserves its arguments", async () => {
  const { DynamicStructuredTool } = await import("@langchain/core/tools");
  const { ToolNode, createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { AIMessage } = await import("@langchain/core/messages");
  const { z } = await import("zod");

  assert.equal(typeof ToolNode, "function");
  assert.equal(typeof createReactAgent, "function");

  const calls = [];
  const send = new DynamicStructuredTool({
    name: "send_email",
    description: "Send an email",
    schema: z.object({ to: z.string(), body: z.string() }),
    func: async (input) => {
      calls.push(["send_email", input]);
      return "sent";
    },
  });
  const invoice = new DynamicStructuredTool({
    name: "create_invoice",
    description: "Create an invoice",
    schema: z.object({ amount: z.number() }),
    func: async (input) => {
      calls.push(["create_invoice", input]);
      return "created";
    },
  });
  const client = fakeClient({
    approveResult: (request) => (request.action === "create_invoice" ? ALLOWED : DENIED),
  });
  const wrapped = withOkedApprovals([send, invoice], { client });
  assert.equal(wrapped[0] instanceof DynamicStructuredTool, true);
  assert.equal(wrapped[0].name, "send_email");
  assert.equal(wrapped[0].schema, send.schema);
  assert.equal(wrapped[1].description, invoice.description);

  const node = new ToolNode(wrapped);
  const result = await node.invoke({
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "send_email",
            args: { to: "a@example.com", body: "hi" },
            id: "c_send",
            type: "tool_call",
          },
          {
            name: "create_invoice",
            args: { amount: 10 },
            id: "c_inv",
            type: "tool_call",
          },
        ],
      }),
    ],
  });
  const messages = result.messages;
  assert.equal(messages.length, 2);
  const denied = messages.find((message) => message.tool_call_id === "c_send");
  const allowed = messages.find((message) => message.tool_call_id === "c_inv");
  assert.match(String(denied.content), /USER DENIED send_email/);
  assert.match(String(denied.content), /was not run/);
  assert.equal(denied.status, "error");
  assert.doesNotMatch(String(denied.content), /Please fix your mistakes/);
  assert.equal(String(allowed.content), "created");
  assert.deepEqual(calls, [["create_invoice", { amount: 10 }]]);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0].tool_input, { to: "a@example.com", body: "hi" });
  assert.deepEqual(client.calls[1].tool_input, { amount: 10 });
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ok - @oked/langgraph: ${passed} passed`);
