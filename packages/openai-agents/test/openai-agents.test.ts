// Unit tests for @oked/openai-agents. approve() is mocked. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tool } from "@openai/agents";
import {
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedReceiptError,
  OKedTooManyPendingError,
  type ApprovalRequest,
  type ApprovalResponse,
} from "@oked/sdk";
import { z } from "zod";
import {
  OKED_TOOL_TIMEOUT_FLOOR_MS,
  OkedToolDeniedError,
  okedTool,
  settleOkedInterruptions,
  withOkedTools,
} from "../dist/index.js";

process.env.HOME = mkdtempSync(join(tmpdir(), "oked-openai-agents-"));
process.env.USERPROFILE = process.env.HOME;
delete process.env.OKED_API_KEY;
delete process.env.OKED_STRICT_FAIL_CLOSED;
delete process.env.OKED_MIN_TIER;
delete process.env.OKED_REQUIRE_RECEIPT;

const quiet = { log() {} };

function approved(id = "ap_ok"): ApprovalResponse {
  return { approved: true, approval_id: id, decision: "approved" };
}

function stopped(decision: "denied" | "timeout", id = "ap_no"): ApprovalResponse {
  return { approved: false, approval_id: id, decision };
}

function refundOptions(execute: (args: { chargeId: string; amount: number }, ctx?: unknown, details?: unknown) => unknown) {
  return {
    name: "refund_payment",
    description: "Refund a charge",
    parameters: z.object({ chargeId: z.string(), amount: z.number() }),
    execute,
  };
}

test("approved call passes arguments through and runs execute", async () => {
  const seen: Array<{ args: unknown; runContext: unknown; details: unknown }> = [];
  const requests: ApprovalRequest[] = [];
  const ctx = { context: { sessionId: "sess_9" } };
  const details = { toolCall: { callId: "call_9" }, marker: true };
  const wrapped = okedTool(
    refundOptions(async (args, runContext, callDetails) => {
      seen.push({ args, runContext, details: callDetails });
      return `refunded ${args.amount}`;
    }),
    {
      ...quiet,
      cwd: "/work/app",
      approve: async (request) => {
        requests.push(request);
        return approved();
      },
    },
  );

  const out = await wrapped.invoke(ctx as never, JSON.stringify({ chargeId: "ch_1", amount: 12 }), details as never);

  assert.equal(out, "refunded 12");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, { chargeId: "ch_1", amount: 12 });
  assert.equal(seen[0].runContext, ctx);
  assert.equal((seen[0].details as { marker?: boolean }).marker, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "refund_payment");
  assert.equal(requests[0].tier, "review");
  assert.deepEqual(requests[0].tool_input, { chargeId: "ch_1", amount: 12 });
  assert.equal(requests[0].session_id, "sess_9");
  assert.equal(requests[0].cwd, "/work/app");
  assert.equal(typeof requests[0].description, "string");
  assert.ok(requests[0].description.length > 0);
});

test("a denial does not run the tool and tells the model not to retry", async () => {
  let ran = false;
  const wrapped = okedTool(
    refundOptions(async () => {
      ran = true;
      return "should not run";
    }),
    { ...quiet, approve: async () => stopped("denied", "ap_deny") },
  );

  const out = await wrapped.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 12 }));

  assert.equal(ran, false);
  assert.equal(typeof out, "string");
  assert.match(String(out), /denied/i);
  assert.match(String(out), /ap_deny/);
  assert.match(String(out), /Do NOT retry/);
  assert.match(String(out), /did not run/i);
});

test("a timeout does not run the tool and is not treated as success", async () => {
  let ran = false;
  const wrapped = okedTool(
    refundOptions(async () => {
      ran = true;
      return "should not run";
    }),
    { ...quiet, approve: async () => stopped("timeout", "ap_time") },
  );

  const out = await wrapped.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 12 }));

  assert.equal(ran, false);
  assert.match(String(out), /timed out/i);
  assert.match(String(out), /ap_time/);
  assert.match(String(out), /Do NOT retry/);
});

test("approve() errors stop the tool", async () => {
  const cases: Array<{ name: string; error: unknown; pattern: RegExp }> = [
    { name: "receipt", error: new OKedReceiptError("no", ["bad_signature"]), pattern: /receipt/i },
    { name: "auth", error: new OKedAuthError("nope", 401), pattern: /API key/i },
    { name: "http", error: new OKedHttpError(400, "bad request"), pattern: /HTTP 400/ },
    { name: "pending", error: new OKedTooManyPendingError(), pattern: /too many approvals/i },
    { name: "generic", error: new Error("socket hang up"), pattern: /socket hang up/ },
  ];

  for (const item of cases) {
    let ran = false;
    const wrapped = okedTool(
      refundOptions(async () => {
        ran = true;
        return "ran";
      }),
      {
        ...quiet,
        approve: async () => {
          throw item.error;
        },
      },
    );
    const out = await wrapped.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 }));
    assert.equal(ran, false, item.name);
    assert.match(String(out), item.pattern, item.name);
    assert.match(String(out), /did not run/i, item.name);
  }
});

test("an unreachable service allows review and denies high_stakes", async () => {
  let reviewRan = false;
  const review = okedTool(
    refundOptions(async () => {
      reviewRan = true;
      return "ran";
    }),
    {
      ...quiet,
      approve: async () => {
        throw new OKedBackendUnreachableError("down");
      },
    },
  );
  assert.equal(await review.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 })), "ran");
  assert.equal(reviewRan, true);

  let stakesRan = false;
  const stakes = okedTool(
    refundOptions(async () => {
      stakesRan = true;
      return "ran";
    }),
    {
      ...quiet,
      alwaysApprove: ["refund_payment"],
      approve: async () => {
        throw new OKedBackendUnreachableError("down");
      },
    },
  );
  const denied = await stakes.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 }));
  assert.equal(stakesRan, false);
  assert.match(String(denied), /high_stakes/);
  assert.match(String(denied), /Do NOT retry/);

  let strictRan = false;
  const strict = okedTool(
    refundOptions(async () => {
      strictRan = true;
      return "ran";
    }),
    {
      ...quiet,
      strictFailClosed: true,
      approve: async () => {
        throw new OKedBackendUnreachableError("down");
      },
    },
  );
  const strictOut = await strict.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 }));
  assert.equal(strictRan, false);
  assert.match(String(strictOut), /strict fail closed/);
});

test("a missing API key denies a sensitive tool and does not call execute", async () => {
  let ran = false;
  const wrapped = okedTool(
    refundOptions(async () => {
      ran = true;
      return "ran";
    }),
    quiet,
  );
  const out = await wrapped.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 }));
  assert.equal(ran, false);
  assert.match(String(out), /OKED_API_KEY/);
  assert.match(String(out), /Do NOT retry/);
});

test("safe tools and shell commands skip approve(); dangerous commands do not", async () => {
  const calls: string[] = [];
  const approve = async (request: ApprovalRequest) => {
    calls.push(`${request.action}:${request.tier}`);
    return approved();
  };

  const reader = okedTool(
    {
      name: "read_file",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }: { path: string }) => `contents:${path}`,
    },
    { ...quiet, approve },
  );
  assert.equal(await reader.invoke({} as never, JSON.stringify({ path: "README.md" })), "contents:README.md");

  const runner = okedTool(
    {
      name: "run_task",
      description: "Run a command",
      parameters: z.object({ command: z.string() }),
      execute: async ({ command }: { command: string }) => command,
    },
    { ...quiet, approve },
  );
  assert.equal(await runner.invoke({} as never, JSON.stringify({ command: "ls" })), "ls");
  assert.equal(await runner.invoke({} as never, JSON.stringify({ command: "git push --force origin main" })), "git push --force origin main");

  assert.deepEqual(calls, ["run_task:high_stakes"]);
});

test("alwaysAllow, alwaysApprove, minTier, and a matching rule", async () => {
  const calls: string[] = [];
  const approve = async (request: ApprovalRequest) => {
    calls.push(request.tier);
    return stopped("denied");
  };

  const allowed = okedTool(refundOptions(async () => "ran"), {
    ...quiet,
    alwaysAllow: ["refund_payment"],
    approve,
  });
  assert.equal(await allowed.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 })), "ran");

  const below = okedTool(refundOptions(async () => "ran"), {
    ...quiet,
    minTier: "high_stakes",
    approve,
  });
  assert.equal(await below.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 })), "ran");

  let forcedRan = false;
  const forced = okedTool(
    {
      name: "read_file",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async () => {
        forcedRan = true;
        return "ran";
      },
    },
    { ...quiet, alwaysApprove: ["read_file"], approve },
  );
  const forcedOut = await forced.invoke({} as never, JSON.stringify({ path: "a.txt" }));
  assert.equal(forcedRan, false);
  assert.match(String(forcedOut), /denied/i);
  assert.deepEqual(calls, ["high_stakes"]);

  let ruledRan = false;
  const ruled = okedTool(
    {
      name: "read_file",
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: async () => {
        ruledRan = true;
        return "ran";
      },
    },
    {
      ...quiet,
      approve: async (request) => {
        calls.push(`rule:${request.action}`);
        return stopped("denied", "ap_rule");
      },
      getRules: async () => [
        {
          id: "escalate",
          match: { kind: { op: "contains", value: "" } },
          action: "set_tier",
          tier: "high_stakes",
        },
      ],
    },
  );
  const ruledOut = await ruled.invoke({} as never, JSON.stringify({ path: "a.txt" }));
  assert.equal(ruledRan, false);
  assert.match(String(ruledOut), /ap_rule/);
  assert.ok(calls.includes("rule:read_file"));
});

test("OKED_MIN_TIER lets a review tool through when set to high_stakes", async () => {
  const previous = process.env.OKED_MIN_TIER;
  process.env.OKED_MIN_TIER = "high_stakes";
  try {
    let asked = false;
    const wrapped = okedTool(refundOptions(async () => "ran"), {
      ...quiet,
      approve: async () => {
        asked = true;
        return stopped("denied");
      },
    });
    assert.equal(await wrapped.invoke({} as never, JSON.stringify({ chargeId: "ch_1", amount: 1 })), "ran");
    assert.equal(asked, false);
  } finally {
    if (previous === undefined) delete process.env.OKED_MIN_TIER;
    else process.env.OKED_MIN_TIER = previous;
  }
});

test("a short tool timeout is raised above the approval wait", () => {
  const wrapped = okedTool(
    { ...refundOptions(async () => "ran"), timeoutMs: 1000 },
    quiet,
  );
  assert.equal(wrapped.timeoutMs, OKED_TOOL_TIMEOUT_FLOOR_MS);

  const custom = okedTool(
    { ...refundOptions(async () => "ran"), timeoutMs: 1000 },
    { ...quiet, timeoutMs: 10_000 },
  );
  assert.equal(custom.timeoutMs, 70_000);
});

test("output schema tools throw on denial unless deniedOutput matches the schema", async () => {
  let ran = false;
  const schemaTool = {
    name: "refund_payment",
    description: "Refund a charge",
    parameters: z.object({ amount: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      ran = true;
      return { ok: true };
    },
  };
  const throwing = okedTool(schemaTool, {
    ...quiet,
    approve: async () => stopped("denied"),
  });
  await assert.rejects(
    () => throwing.invoke({} as never, JSON.stringify({ amount: 5 })),
    (err: unknown) => err instanceof OkedToolDeniedError && /Do NOT retry/.test(err.message),
  );
  assert.equal(ran, false);

  const shaped = okedTool(schemaTool, {
    ...quiet,
    approve: async () => stopped("timeout"),
    deniedOutput: () => ({ ok: false }),
  });
  assert.deepEqual(await shaped.invoke({} as never, JSON.stringify({ amount: 5 })), { ok: false });
  assert.equal(ran, false);
});

test("withOkedTools gates an existing function tool and passes arguments through", async () => {
  const seen: unknown[] = [];
  const requests: ApprovalRequest[] = [];
  const original = tool({
    name: "refund_payment",
    description: "Refund a charge",
    parameters: z.object({ chargeId: z.string(), amount: z.number() }),
    execute: async (args) => {
      seen.push(args);
      return `original ${args.amount}`;
    },
  });
  const ctx = { context: { session_id: "from_context" } };
  const [wrapped] = withOkedTools([original], {
    ...quiet,
    approve: async (request) => {
      requests.push(request);
      return approved("ap_list");
    },
  });

  assert.notEqual(wrapped, original);
  const out = await wrapped.invoke(ctx as never, JSON.stringify({ chargeId: "ch_9", amount: 4 }));
  assert.equal(out, "original 4");
  assert.deepEqual(seen, [{ chargeId: "ch_9", amount: 4 }]);
  assert.equal(requests[0].session_id, "from_context");
  assert.deepEqual(requests[0].tool_input, { chargeId: "ch_9", amount: 4 });

  const [again] = withOkedTools([wrapped], {
    ...quiet,
    approve: async () => {
      throw new Error("second wrap must not ask");
    },
  });
  assert.equal(again, wrapped);
  assert.equal(await again.invoke(ctx as never, JSON.stringify({ chargeId: "ch_9", amount: 4 })), "original 4");
  assert.equal(requests.length, 2);
});

test("shell and apply_patch resolve through onApproval without running on a denial", async () => {
  const calls: ApprovalRequest[] = [];
  const approve = async (request: ApprovalRequest) => {
    calls.push(request);
    return stopped(request.tier === "high_stakes" ? "timeout" : "denied", "ap_shell");
  };
  let shellRan = false;
  const shell = {
    type: "shell" as const,
    name: "shell",
    shell: {
      run: async () => {
        shellRan = true;
        return { stdout: "", stderr: "", outcome: { type: "exit", exitCode: 0 } };
      },
    },
    environment: { type: "local" as const },
    needsApproval: async () => false,
    onApproval: async () => ({ approve: true }),
  };
  const patch = {
    type: "apply_patch" as const,
    name: "apply_patch",
    editor: { apply: async () => ({ status: "completed" as const }) },
    needsApproval: async () => false,
  };
  const originalNeeds = shell.needsApproval;
  const [wrappedShell, wrappedPatch] = withOkedTools([shell, patch], { ...quiet, approve });

  assert.equal(shell.needsApproval, originalNeeds);
  assert.notEqual(wrappedShell.needsApproval, originalNeeds);
  assert.equal(await wrappedShell.needsApproval({}, { commands: ["ls"] }, "c1"), true);

  const listed = await wrappedShell.onApproval?.(
    {},
    { name: "shell", rawItem: { type: "shell_call", action: { commands: ["ls"] } } },
  );
  assert.deepEqual(listed, { approve: true });
  assert.equal(shellRan, false);
  assert.equal(calls.length, 0);

  const removed = await wrappedShell.onApproval?.(
    {},
    { name: "shell", rawItem: { type: "shell_call", action: { commands: ["rm -rf /var/data"] } } },
  );
  assert.equal(removed?.approve, false);
  assert.match(removed?.reason ?? "", /timed out|Do NOT retry/);
  assert.equal(shellRan, false);
  assert.equal(calls[0].tier, "high_stakes");
  assert.match(String((calls[0].tool_input as { command?: string }).command), /rm -rf \/var\/data/);

  const deleted = await wrappedPatch.onApproval?.(
    {},
    {
      name: "apply_patch",
      rawItem: { type: "apply_patch_call", operation: { type: "delete_file", path: "/var/data/db" } },
    },
  );
  assert.equal(deleted?.approve, false);
  assert.equal(calls.at(-1)?.action, "apply_patch");
  assert.equal(calls.at(-1)?.tier, "high_stakes");
});

test("hosted shell is left unchanged and hosted MCP denials do not approve", async () => {
  const notes: string[] = [];
  const hosted = {
    type: "shell" as const,
    name: "shell",
    environment: { type: "container_auto" as const },
    needsApproval: async () => false,
  };
  const mcp = {
    type: "hosted_tool" as const,
    name: "hosted_mcp",
    providerData: {
      type: "mcp",
      server_label: "billing",
      require_approval: "never",
    },
  };
  const computer = { type: "computer" as const, name: "computer" };
  const [sameShell, wrappedMcp, sameComputer] = withOkedTools([hosted, mcp, computer], {
    log: (message) => notes.push(message),
    approve: async () => stopped("denied", "ap_mcp"),
  });

  assert.equal(sameShell, hosted);
  assert.equal(sameComputer, computer);
  assert.match(notes.join("\n"), /hosted shell/);
  assert.equal(mcp.providerData.require_approval, "never");
  assert.equal(wrappedMcp.providerData?.require_approval, "always");
  const onApproval = wrappedMcp.providerData?.on_approval as
    | ((ctx: unknown, item: unknown) => Promise<{ approve: boolean; reason?: string }>)
    | undefined;
  assert.equal(typeof onApproval, "function");
  const verdict = await onApproval?.({}, {
    name: "create_charge",
    arguments: JSON.stringify({ amount: 10 }),
    rawItem: { type: "function_call", name: "create_charge", arguments: JSON.stringify({ amount: 10 }) },
  });
  assert.equal(verdict?.approve, false);
  assert.match(verdict?.reason ?? "", /ap_mcp/);
  assert.match(verdict?.reason ?? "", /Do NOT retry/);
});

test("settleOkedInterruptions approves, rejects a timeout, and rejects an error", async () => {
  const approved: unknown[] = [];
  const rejected: Array<{ item: unknown; message?: string }> = [];
  const state = {
    approve(item: unknown) {
      approved.push(item);
    },
    reject(item: unknown, options?: { message?: string }) {
      rejected.push({ item, message: options?.message });
    },
  };
  const okItem = { name: "refund_payment", arguments: JSON.stringify({ chargeId: "ch_1", amount: 5 }) };
  const slowItem = { name: "refund_payment", arguments: JSON.stringify({ chargeId: "ch_2", amount: 9 }) };
  const badItem = { name: "refund_payment", arguments: JSON.stringify({ chargeId: "ch_3", amount: 3 }) };

  const settled = await settleOkedInterruptions(
    { interruptions: [okItem, slowItem, badItem], state },
    {
      ...quiet,
      approve: async (request) => {
        const amount = (request.tool_input as { amount?: number }).amount;
        if (amount === 5) return approvedResponse();
        if (amount === 9) return stopped("timeout", "ap_slow");
        throw new OKedReceiptError("mismatch", ["subject_mismatch"]);
      },
    },
  );

  assert.equal(settled.settled, 3);
  assert.deepEqual(approved, [okItem]);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].message ?? "", /timed out/i);
  assert.match(rejected[0].message ?? "", /Do NOT retry/);
  assert.match(rejected[1].message ?? "", /receipt/i);
  assert.equal(rejected[0].item, slowItem);
  assert.equal(rejected[1].item, badItem);
});

function approvedResponse(): ApprovalResponse {
  return approved("ap_resume");
}
