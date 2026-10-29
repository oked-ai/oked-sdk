// Unit tests for the Vercel AI SDK gate. approve() is a mock, except for two
// cases that drive the real OKedClient through a mocked fetch. No live network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import {
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
  classify,
  describe as describeAction,
} from "@oked/sdk";
import {
  OkedDeniedError,
  isOkedDenial,
  okedToolApproval,
  okedToolApprovalFor,
  okedTools,
  withOked,
} from "../dist/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function harness(approve, extras = {}) {
  const requests = [];
  const logs = [];
  const client = {
    apiKey: "ok_test",
    strictFailClosed: false,
    async approve(request) {
      requests.push(request);
      if (typeof approve === "function") return approve(request);
      return approve;
    },
    async getRules() {
      return extras.rules ?? [];
    },
    async heartbeat() {},
    ...extras.client,
  };
  const options = {
    client,
    log(message) {
      logs.push(message);
    },
    ...extras.options,
  };
  return { client, requests, logs, options };
}

const approved = { approved: true, approval_id: "ap_1", decision: "approved" };
const denied = { approved: false, approval_id: "ap_2", decision: "denied" };

function paymentCall(input = { amount: 50, recipient: "vendor@example.com" }, toolCallId = "call-1") {
  return { toolCall: { toolName: "processPayment", input, toolCallId } };
}

function assertNotUserApproval(status) {
  assert.notEqual(status, "user-approval");
  if (status && typeof status === "object") assert.notEqual(status.type, "user-approval");
}

describe("classifier assumptions", () => {
  it("uses the tiers these tests depend on", () => {
    assert.equal(classify("processPayment", { amount: 10 }), "review");
    assert.equal(classify("read_file", { file_path: "a.txt" }), "safe");
    assert.equal(classify("Read", { file_path: "a.txt" }), "safe");
    assert.equal(classify("save_note", { path: "notes.txt", content: "hello" }), "warning");
    assert.equal(classify("exec", { command: "rm -rf /var/data" }), "high_stakes");
  });
});

describe("okedToolApproval", () => {
  it("asks approve() with the tool arguments and returns approved", async () => {
    const input = { amount: 50, recipient: "vendor@example.com" };
    const { requests, options } = harness(approved);
    const status = await okedToolApproval({ ...options, cwd: "/work/app", sessionId: "sess-9" })(
      paymentCall(input, "call-1"),
    );
    assert.deepEqual(status, { type: "approved", reason: "Approved via OKed (approval ap_1)" });
    assertNotUserApproval(status);
    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.action, "processPayment");
    assert.equal(req.tier, "review");
    assert.equal(req.description, "processPayment");
    assert.equal(req.tool_input, input);
    assert.equal(req.session_id, "sess-9");
    assert.equal(req.cwd, "/work/app");
    assert.equal(req.fields.Title, "processPayment");
    assert.equal(req.fields.Kind, "unknown_tool");
    assert.match(req.fields.Body, /amount: 50/);
    assert.match(req.fields.Body, /vendor@example.com/);
    assert.deepEqual(Object.keys(input), ["amount", "recipient"]);
  });

  it("uses the tool call id as the session when none is configured", async () => {
    const { requests, options } = harness(approved);
    await okedToolApproval(options)(paymentCall({ amount: 1 }, "call-77"));
    assert.equal(requests[0].session_id, "call-77");
  });

  it("returns a denial the model can read and does not treat it as user-approval", async () => {
    const { requests, logs, options } = harness(denied);
    const status = await okedToolApproval(options)(paymentCall());
    assert.equal(status.type, "denied");
    assert.match(status.reason, /USER DENIED this action via OKed \(approval ap_2\)/);
    assert.match(status.reason, /Do NOT retry/);
    assertNotUserApproval(status);
    assert.equal(requests.length, 1);
    assert.ok(logs.some((line) => line.includes("Blocking processPayment")));
  });

  it("treats a timeout as a denial, including a timeout with no approval id", async () => {
    const { options } = harness({ approved: false, approval_id: null, decision: "timeout" });
    const status = await okedToolApproval(options)(paymentCall());
    assert.equal(status.type, "denied");
    assert.match(status.reason, /did not respond/);
    assert.match(status.reason, /approval window expired/);
    assert.match(status.reason, /Do NOT retry/);
    assert.doesNotMatch(status.reason, /null/);
    assertNotUserApproval(status);
  });

  it("denies when approve() returns a human denial without a decision string", async () => {
    const { options } = harness({ approved: false, approval_id: "ap_x" });
    const status = await okedToolApproval(options)(paymentCall());
    assert.equal(status.type, "denied");
    assert.match(status.reason, /DENIED/);
    assert.match(status.reason, /ap_x/);
  });

  it("denies a malformed approve() response", async () => {
    const { options } = harness(undefined);
    const status = await okedToolApproval(options)(paymentCall());
    assert.equal(status.type, "denied");
    assert.match(status.reason, /malformed/);
  });

  it("lets a safe tool run without calling approve()", async () => {
    const { requests, options } = harness(approved);
    const status = await okedToolApproval(options)({
      toolCall: { toolName: "read_file", input: { file_path: "README.md" }, toolCallId: "r1" },
    });
    assert.equal(status, undefined);
    assert.equal(requests.length, 0);
    assertNotUserApproval(status);
  });

  it("lets a warning tool run, logs it, and does not call approve()", async () => {
    const { requests, logs, options } = harness(approved);
    const status = await okedToolApproval(options)({
      toolCall: { toolName: "save_note", input: { path: "notes.txt", content: "hello" } },
    });
    assert.equal(status, undefined);
    assert.equal(requests.length, 0);
    assert.ok(logs.some((line) => line.startsWith("WARNING save_note notes.txt")));
  });

  it("reads args when input is missing, and prefers input when both are set", async () => {
    const { requests, options } = harness(denied);
    const gate = okedToolApproval(options);
    await gate({ toolCall: { toolName: "processPayment", args: { amount: 2 }, toolCallId: "a1" } });
    assert.deepEqual(requests[0].tool_input, { amount: 2 });
    await gate({
      toolCall: { toolName: "processPayment", input: { amount: 3 }, args: { amount: 9 }, toolCallId: "a2" },
    });
    assert.deepEqual(requests[1].tool_input, { amount: 3 });
  });

  it("wraps a non-object input so the card still has arguments", async () => {
    const { requests, options } = harness(denied);
    await okedToolApproval(options)({
      toolCall: { toolName: "processPayment", input: "raw", toolCallId: "s1" },
    });
    assert.deepEqual(requests[0].tool_input, { value: "raw" });
  });

  it("gates a dynamic tool call by its name", async () => {
    const { requests, options } = harness(denied);
    await okedToolApproval(options)({
      toolCall: { toolName: "processPayment", input: { amount: 1 }, dynamic: true, toolCallId: "d1" },
    });
    assert.equal(requests[0].action, "processPayment");
    assert.equal(requests[0].session_id, "d1");
  });

  it("denies a call that has no tool name", async () => {
    const { requests, options } = harness(approved);
    const missing = await okedToolApproval(options)({});
    const blank = await okedToolApproval(options)({ toolCall: { toolName: "   ", input: {} } });
    assert.equal(missing.type, "denied");
    assert.match(missing.reason, /no name/);
    assert.equal(blank.type, "denied");
    assert.equal(requests.length, 0);
  });

  it("alwaysAllow skips approval, and wins over alwaysApprove", async () => {
    const { requests, options } = harness(approved);
    const status = await okedToolApproval({
      ...options,
      alwaysAllow: ["exec"],
      alwaysApprove: ["exec"],
    })({ toolCall: { toolName: "exec", input: { command: "rm -rf /var/data" } } });
    assert.equal(status, undefined);
    assert.equal(requests.length, 0);
  });

  it("alwaysApprove sends a safe tool to approve() at review tier", async () => {
    const { requests, options } = harness(approved);
    const status = await okedToolApproval({ ...options, alwaysApprove: ["read_file"] })({
      toolCall: { toolName: "read_file", input: { file_path: "a.txt" }, toolCallId: "ra" },
    });
    assert.equal(status.type, "approved");
    assert.equal(requests[0].action, "read_file");
    assert.equal(requests[0].tier, "review");
    assert.equal(requests[0].tool_input.file_path, "a.txt");
  });

  it("minTier high_stakes lets a review tool run and still asks for high_stakes", async () => {
    const { requests, options } = harness(denied);
    const gate = okedToolApproval({ ...options, minTier: "high_stakes" });
    const review = await gate(paymentCall({ amount: 1 }, "m1"));
    assert.equal(review, undefined);
    assert.equal(requests.length, 0);
    const high = await gate({
      toolCall: { toolName: "exec", input: { command: "rm -rf /var/data" }, toolCallId: "m2" },
    });
    assert.equal(high.type, "denied");
    assert.equal(requests[0].tier, "high_stakes");
    assert.equal(requests[0].tool_input.command, "rm -rf /var/data");
  });

  it("OKED_MIN_TIER applies, and an explicit minTier wins", async () => {
    const prev = process.env.OKED_MIN_TIER;
    process.env.OKED_MIN_TIER = "high_stakes";
    try {
      const { requests, options } = harness(denied);
      const skipped = await okedToolApproval(options)(paymentCall({ amount: 1 }, "e1"));
      assert.equal(skipped, undefined);
      assert.equal(requests.length, 0);
      const forced = await okedToolApproval({ ...options, minTier: "review" })(paymentCall({ amount: 2 }, "e2"));
      assert.equal(forced.type, "denied");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].tool_input.amount, 2);
    } finally {
      if (prev === undefined) delete process.env.OKED_MIN_TIER;
      else process.env.OKED_MIN_TIER = prev;
    }
  });

  it("sends a safe tool to approve() when a saved rule matches", async () => {
    const input = { file_path: "a.txt" };
    const title = describeAction("Read", input);
    const { requests, options } = harness(denied, {
      rules: [{ id: "rule-1", match: { title: { op: "equals", value: title } }, action: "auto_deny" }],
    });
    const status = await okedToolApproval(options)({
      toolCall: { toolName: "Read", input, toolCallId: "rule-call" },
    });
    assert.equal(status.type, "denied");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, "Read");
    assert.equal(requests[0].tier, "safe");
    assert.equal(requests[0].tool_input, input);
    assert.equal(requests[0].session_id, "rule-call");
  });

  it("still allows a safe tool when the rules lookup throws", async () => {
    const { requests, client, options } = harness(approved);
    client.getRules = async () => {
      throw new Error("rules down");
    };
    const status = await okedToolApproval(options)({
      toolCall: { toolName: "read_file", input: { file_path: "a.txt" } },
    });
    assert.equal(status, undefined);
    assert.equal(requests.length, 0);
  });

  it("still asks for a review tool when the rules lookup would throw", async () => {
    const { requests, client, options } = harness(approved);
    client.getRules = async () => {
      throw new Error("rules down");
    };
    const status = await okedToolApproval(options)(paymentCall({ amount: 4 }, "g1"));
    assert.equal(status.type, "approved");
    assert.equal(requests.length, 1);
  });

  it("pings heartbeat for a safe tool, and a heartbeat failure does not change the decision", async () => {
    const { client, options, requests } = harness(approved);
    let beats = 0;
    client.heartbeat = async () => {
      beats += 1;
    };
    const first = await okedToolApproval(options)({
      toolCall: { toolName: "read_file", input: { file_path: "a.txt" } },
    });
    assert.equal(first, undefined);
    assert.equal(beats, 1);
    assert.equal(requests.length, 0);

    client.heartbeat = async () => {
      throw new Error("heartbeat down");
    };
    const second = await okedToolApproval(options)({
      toolCall: { toolName: "read_file", input: { file_path: "b.txt" } },
    });
    assert.equal(second, undefined);
  });
});

describe("error paths", () => {
  const cases = [
    {
      name: "auth error",
      error: () => new OKedAuthError("nope", 401),
      pattern: /invalid API key/,
    },
    {
      name: "receipt error",
      error: () => new OKedReceiptError("bad signature", ["bad_signature"]),
      pattern: /receipt did not verify \(bad_signature\)/,
    },
    {
      name: "too many pending",
      error: () => new OKedTooManyPendingError("queue"),
      pattern: /too many approvals/i,
    },
    {
      name: "http error",
      error: () => new OKedHttpError(400, "bad request"),
      pattern: /HTTP 400: bad request/,
    },
    {
      name: "unexpected error",
      error: () => new Error("socket hang up"),
      pattern: /socket hang up/,
    },
  ];

  for (const item of cases) {
    it(`denies a review tool on ${item.name}`, async () => {
      const { options } = harness(() => {
        throw item.error();
      });
      const status = await okedToolApproval(options)(paymentCall());
      assert.equal(status.type, "denied");
      assert.match(status.reason, item.pattern);
      assert.match(status.reason, /Do NOT retry/);
      assertNotUserApproval(status);
    });
  }

  it("allows a review tool when the backend is unreachable, and denies it when strict", async () => {
    const open = harness(() => {
      throw new OKedBackendUnreachableError("down");
    });
    const allowed = await okedToolApproval(open.options)(paymentCall({ amount: 1 }, "u1"));
    assert.equal(allowed, undefined);
    assert.ok(open.logs.some((line) => line.includes("allowed (degraded, non-high-stakes)")));

    const closed = harness(
      () => {
        throw new OKedBackendUnreachableError("down");
      },
      { options: { strictFailClosed: true } },
    );
    assert.equal(closed.client.strictFailClosed, false);
    const deniedStatus = await okedToolApproval(closed.options)(paymentCall({ amount: 2 }, "u2"));
    assert.equal(deniedStatus.type, "denied");
    assert.match(deniedStatus.reason, /strict fail-closed/);
    assert.match(deniedStatus.reason, /Do NOT retry/);
  });

  it("denies high_stakes when the backend is unreachable even without strict mode", async () => {
    const { options } = harness(() => {
      throw new OKedBackendUnreachableError("down");
    });
    const status = await okedToolApproval(options)({
      toolCall: { toolName: "exec", input: { command: "rm -rf /var/data" }, toolCallId: "hs" },
    });
    assert.equal(status.type, "denied");
    assert.match(status.reason, /high-stakes/);
    assert.match(status.reason, /not run/);
  });

  it("denies when the classifier throws", async () => {
    const { requests, options } = harness(approved);
    const input = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const status = await okedToolApproval(options)({
      toolCall: { toolName: "processPayment", input, toolCallId: "px" },
    });
    assert.equal(status.type, "denied");
    assert.match(status.reason, /classifier failed/);
    assert.equal(requests.length, 0);
  });

  it("denies a sensitive tool when no API key is set, and still allows a safe tool", async () => {
    const { options, client } = harness(approved);
    client.apiKey = "";
    client.approve = async () => {
      throw new Error("approve should not be called");
    };
    const sensitive = await okedToolApproval(options)(paymentCall());
    assert.equal(sensitive.type, "denied");
    assert.match(sensitive.reason, /no API key/);
    assert.match(sensitive.reason, /dashboard/);
    const safe = await okedToolApproval(options)({
      toolCall: { toolName: "read_file", input: { file_path: "a.txt" } },
    });
    assert.equal(safe, undefined);
    const forced = await okedToolApproval({ ...options, alwaysApprove: ["read_file"] })({
      toolCall: { toolName: "read_file", input: { file_path: "a.txt" } },
    });
    assert.equal(forced.type, "denied");
    assert.match(forced.reason, /no API key/);
  });
});

describe("withOked and okedTools", () => {
  it("forwards input and options to execute after an approval", async () => {
    const { requests, options } = harness(approved);
    let seen;
    const original = {
      description: "Pay a vendor",
      needsApproval: true,
      async execute(input, opts) {
        seen = { input, opts };
        return { paid: true, input };
      },
    };
    const tool = withOked(original, { ...options, name: "processPayment", cwd: "/work/app" });
    const input = { amount: 50, recipient: "vendor@example.com" };
    const execOptions = { toolCallId: "call-7", abortSignal: new AbortController().signal, messages: [] };
    const out = await tool.execute(input, execOptions);
    assert.deepEqual(out, { paid: true, input });
    assert.equal(seen.input, input);
    assert.equal(seen.opts, execOptions);
    assert.equal(requests[0].tool_input, input);
    assert.equal(requests[0].session_id, "call-7");
    assert.equal(requests[0].cwd, "/work/app");
    assert.equal(requests[0].action, "processPayment");
    assert.equal(tool.description, "Pay a vendor");
    assert.equal("needsApproval" in tool, false);
    assert.equal(original.needsApproval, true);
    assert.notEqual(tool.execute, original.execute);
  });

  it("does not call execute on deny, timeout, or error", async () => {
    const outcomes = [
      { name: "deny", approve: denied, pattern: /DENIED/ },
      {
        name: "timeout",
        approve: { approved: false, approval_id: "ap_t", decision: "timeout" },
        pattern: /did not respond/,
      },
      {
        name: "error",
        approve: () => {
          throw new OKedAuthError("nope", 401);
        },
        pattern: /invalid API key/,
      },
    ];
    for (const outcome of outcomes) {
      let ran = false;
      const { options } = harness(outcome.approve);
      const tool = withOked(
        {
          async execute() {
            ran = true;
            return "ran";
          },
        },
        { ...options, name: "processPayment" },
      );
      const result = await tool.execute({ amount: 5 }, { toolCallId: "stop" });
      assert.equal(ran, false, outcome.name);
      assert.equal(isOkedDenial(result), true, outcome.name);
      assert.match(result.reason, outcome.pattern, outcome.name);
      assert.match(result.reason, /Do NOT retry/, outcome.name);
      assert.equal(result.tier, "review", outcome.name);
    }
  });

  it("forwards arguments for a safe tool without calling approve()", async () => {
    const { requests, options } = harness(approved);
    let seen;
    const tool = withOked(
      {
        async execute(input, opts) {
          seen = { input, opts };
          return "file";
        },
      },
      { ...options, name: "read_file" },
    );
    const input = { file_path: "a.txt" };
    const opts = { toolCallId: "safe-1" };
    const result = await tool.execute(input, opts);
    assert.equal(result, "file");
    assert.equal(seen.input, input);
    assert.equal(seen.opts, opts);
    assert.equal(requests.length, 0);
    assert.equal(isOkedDenial(result), false);
  });

  it("throws OkedDeniedError when the tool defines outputSchema", async () => {
    let ran = false;
    const { options } = harness(denied);
    const tool = withOked(
      {
        outputSchema: { parse() {} },
        async execute() {
          ran = true;
          return { ok: true };
        },
      },
      { ...options, name: "processPayment" },
    );
    await assert.rejects(
      () => tool.execute({ amount: 1 }, { toolCallId: "out" }),
      (err) => {
        assert.ok(err instanceof OkedDeniedError);
        assert.equal(isOkedDenial(err), true);
        assert.match(err.message, /DENIED/);
        assert.equal(err.reason, err.message);
        assert.equal(err.approvalId, "ap_2");
        return true;
      },
    );
    assert.equal(ran, false);
  });

  it("leaves the original execute ungated", async () => {
    const original = {
      async execute() {
        return "raw";
      },
    };
    const { options } = harness(denied);
    const wrapped = withOked(original, { ...options, name: "processPayment" });
    const blocked = await wrapped.execute({ amount: 1 });
    assert.equal(isOkedDenial(blocked), true);
    assert.equal(await original.execute({ amount: 1 }), "raw");
  });

  it("requires a name and an execute function", () => {
    assert.throws(() => withOked({ async execute() {} }, { name: "  " }), /tool name/);
    assert.throws(() => withOked({ description: "search" }, { name: "webSearch" }), /no execute/);
  });

  it("wraps a tools object, shares one approve(), and leaves provider tools alone", async () => {
    const { requests, logs, options } = harness(denied);
    const webSearch = { description: "provider search" };
    let reads = 0;
    const tools = okedTools(
      {
        read_file: {
          async execute(input) {
            reads += 1;
            return input;
          },
        },
        processPayment: {
          async execute() {
            return { paid: true };
          },
        },
        webSearch,
      },
      options,
    );
    assert.equal(tools.webSearch, webSearch);
    assert.ok(logs.some((line) => line.includes('tool "webSearch"') && line.includes("not gated")));
    const read = await tools.read_file.execute({ file_path: "a.txt" }, { toolCallId: "rf" });
    assert.deepEqual(read, { file_path: "a.txt" });
    assert.equal(reads, 1);
    assert.equal(requests.length, 0);
    const blocked = await tools.processPayment.execute({ amount: 9 }, { toolCallId: "pay" });
    assert.equal(isOkedDenial(blocked), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, "processPayment");
    assert.equal(requests[0].tool_input.amount, 9);
    assert.equal(requests[0].session_id, "pay");
  });

  it("does not run execute when the unreachable backend denies high_stakes", async () => {
    let ran = false;
    const { options } = harness(() => {
      throw new OKedBackendUnreachableError("down");
    });
    const tool = withOked(
      {
        async execute() {
          ran = true;
          return "ran";
        },
      },
      { ...options, name: "exec" },
    );
    const result = await tool.execute({ command: "rm -rf /var/data" });
    assert.equal(ran, false);
    assert.equal(isOkedDenial(result), true);
    assert.equal(result.decision, "error");
    assert.equal(result.tier, "high_stakes");
  });

  it("runs execute when a review tool is allowed under a degraded backend", async () => {
    let seen;
    const { options } = harness(() => {
      throw new OKedBackendUnreachableError("down");
    });
    const tool = withOked(
      {
        async execute(input, opts) {
          seen = { input, opts };
          return "ran";
        },
      },
      { ...options, name: "processPayment" },
    );
    const input = { amount: 3 };
    const opts = { toolCallId: "deg" };
    const result = await tool.execute(input, opts);
    assert.equal(result, "ran");
    assert.equal(seen.input, input);
    assert.equal(seen.opts, opts);
  });
});

describe("okedToolApprovalFor", () => {
  it("binds the tool name and passes input and toolCallId to approve()", async () => {
    const { requests, options } = harness(denied);
    const gate = okedToolApprovalFor("processPayment", { ...options, cwd: "/srv" });
    const input = { amount: 8, recipient: "a@b.c" };
    const status = await gate(input, { toolCallId: "call-9" });
    assert.equal(status.type, "denied");
    assert.match(status.reason, /DENIED/);
    assert.equal(requests[0].action, "processPayment");
    assert.equal(requests[0].tool_input, input);
    assert.equal(requests[0].session_id, "call-9");
    assert.equal(requests[0].cwd, "/srv");
    assert.equal(requests[0].tier, "review");
  });
});

describe("isOkedDenial", () => {
  it("accepts a denial object and rejects other values", () => {
    assert.equal(
      isOkedDenial({
        oked: "denied",
        decision: "timeout",
        approvalId: null,
        reason: "no",
        tier: "high_stakes",
      }),
      true,
    );
    assert.equal(isOkedDenial(null), false);
    assert.equal(isOkedDenial({ ok: true }), false);
    assert.equal(isOkedDenial({ oked: "denied", decision: "nope", approvalId: null, reason: "x", tier: "review" }), false);
  });
});

function envKeys() {
  return ["HOME", "USERPROFILE", ...Object.keys(process.env).filter((key) => key.startsWith("OKED_"))];
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prev) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OKED_") && !(key in prev)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("real OKedClient", () => {
  let home;
  let prevEnv;
  let prevFetch;

  afterEach(() => {
    if (prevFetch) globalThis.fetch = prevFetch;
    if (prevEnv) restoreEnv(prevEnv);
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    prevEnv = undefined;
    prevFetch = undefined;
  });

  function isolate() {
    prevEnv = snapshotEnv(envKeys());
    home = mkdtempSync(join(tmpdir(), "oked-ai-sdk-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OKED_")) delete process.env[key];
    }
  }

  it("denies a sensitive tool without a key and does not call fetch", async () => {
    isolate();
    let fetches = 0;
    prevFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    };
    let ran = false;
    const tool = withOked(
      {
        async execute() {
          ran = true;
          return "ran";
        },
      },
      { name: "processPayment", log() {} },
    );
    const result = await tool.execute({ amount: 1 });
    assert.equal(ran, false);
    assert.equal(fetches, 0);
    assert.equal(isOkedDenial(result), true);
    assert.match(result.reason, /no API key/);
  });

  it("sends approve() arguments on the real client and denies the tool", async () => {
    isolate();
    process.env.OKED_API_KEY = "ok_test_key";
    const calls = [];
    prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: init?.headers?.Authorization,
      });
      if (String(url).endsWith("/api/v1/approve")) {
        return new Response(
          JSON.stringify({ approval_id: "ap_real", decision: "denied", status: "denied" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    let ran = false;
    const input = { amount: 20, recipient: "vendor@example.com" };
    const tool = withOked(
      {
        async execute() {
          ran = true;
          return "ran";
        },
      },
      { name: "processPayment", cwd: "/work/repo", timeoutMs: 2000, log() {} },
    );
    const result = await tool.execute(input, { toolCallId: "call-real" });
    assert.equal(ran, false);
    assert.equal(isOkedDenial(result), true);
    assert.equal(result.decision, "denied");
    assert.equal(result.approvalId, "ap_real");

    const approve = calls.find((call) => call.url === "https://api.oked.ai/api/v1/approve");
    assert.ok(approve, "expected an approve request");
    assert.equal(approve.method, "POST");
    assert.equal(approve.authorization, "Bearer ok_test_key");
    const body = JSON.parse(approve.body);
    assert.equal(body.action, "processPayment");
    assert.equal(body.tier, "review");
    assert.equal(body.description, "processPayment");
    assert.equal(body.client, `@oked/ai-sdk@${pkg.version}`);
    assert.equal(body.metadata.source, "ai-sdk");
    assert.equal(body.metadata.session_id, "call-real");
    assert.equal(body.metadata.cwd, "/work/repo");
    assert.deepEqual(body.metadata.tool_input, input);
    assert.equal(body.fields.Title, "processPayment");
    assert.equal(body.fields.Kind, "unknown_tool");
    assert.equal(typeof body.nonce, "string");
    assert.ok(body.nonce.length > 0);
  });

  it("denies an approval that arrives without a receipt", async () => {
    isolate();
    process.env.OKED_API_KEY = "ok_test_key";
    prevFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/api/v1/approve")) {
        return new Response(
          JSON.stringify({ approval_id: "ap_missing", decision: "approved", status: "approved" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    let ran = false;
    const gate = okedToolApproval({ timeoutMs: 2000, log() {} });
    const status = await gate(paymentCall({ amount: 5 }, "receipt-call"));
    const tool = withOked(
      {
        async execute() {
          ran = true;
          return "ran";
        },
      },
      { name: "processPayment", timeoutMs: 2000, log() {} },
    );
    const result = await tool.execute({ amount: 5 });
    assert.equal(status.type, "denied");
    assert.match(status.reason, /receipt did not verify/);
    assert.equal(ran, false);
    assert.equal(isOkedDenial(result), true);
    assert.match(result.reason, /receipt/);
  });
});
