import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  OKedClient,
  degradedDecision,
  TIER_ORDER,
  OKedAuthError,
  OKedBackendUnreachableError,
} from "../src/index.js";

describe("degradedDecision", () => {
  it("strictFailClosed denies every tier", () => {
    for (const tier of ["safe", "warning", "review", "high_stakes"] as const) {
      assert.equal(degradedDecision(tier, { strictFailClosed: true }), "deny");
    }
  });

  it("default: allows non-high-stakes, denies high_stakes", () => {
    assert.equal(degradedDecision("safe", {}), "allow");
    assert.equal(degradedDecision("warning", {}), "allow");
    assert.equal(degradedDecision("review", {}), "allow");
    assert.equal(degradedDecision("high_stakes", {}), "deny");
    assert.equal(degradedDecision("high_stakes", { strictFailClosed: false }), "deny");
  });
});

describe("TIER_ORDER", () => {
  it("orders tiers by severity", () => {
    assert.ok(
      TIER_ORDER.safe < TIER_ORDER.warning &&
        TIER_ORDER.warning < TIER_ORDER.review &&
        TIER_ORDER.review < TIER_ORDER.high_stakes,
    );
  });
});

describe("OKedClient.strictFailClosed precedence", () => {
  it("defaults to false", () => {
    delete process.env.OKED_STRICT_FAIL_CLOSED;
    assert.equal(new OKedClient({ apiKey: "k" }).strictFailClosed, false);
  });

  it("env OKED_STRICT_FAIL_CLOSED=1 enables it", () => {
    process.env.OKED_STRICT_FAIL_CLOSED = "1";
    try {
      assert.equal(new OKedClient({ apiKey: "k" }).strictFailClosed, true);
    } finally {
      delete process.env.OKED_STRICT_FAIL_CLOSED;
    }
  });

  it("constructor overrides env", () => {
    process.env.OKED_STRICT_FAIL_CLOSED = "1";
    try {
      assert.equal(
        new OKedClient({ apiKey: "k", strictFailClosed: false }).strictFailClosed,
        false,
      );
    } finally {
      delete process.env.OKED_STRICT_FAIL_CLOSED;
    }
  });
});

describe("OKedClient.approve typed errors", () => {
  it("throws OKedBackendUnreachableError on a closed port", async () => {
    const client = new OKedClient({
      apiKey: "k",
      backendUrl: "http://127.0.0.1:1",
      timeout: 2000,
    });
    await assert.rejects(
      () =>
        client.approve({ action: "Bash", description: "x", tier: "review" }),
      OKedBackendUnreachableError,
    );
  });

  describe("with a stub server", () => {
    let server: Server;
    let port = 0;
    let status = 200;

    before(async () => {
      server = createServer((_req, res) => {
        if (status === 200) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              approval_id: "a1",
              decision: "denied",
              status: "denied",
            }),
          );
        } else {
          res.writeHead(status);
          res.end("err");
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as { port: number }).port;
    });

    after(() => server.close());

    it("401 -> OKedAuthError (not an outage)", async () => {
      status = 401;
      const client = new OKedClient({
        apiKey: "bad",
        backendUrl: `http://127.0.0.1:${port}`,
        timeout: 2000,
      });
      await assert.rejects(
        () => client.approve({ action: "Bash", description: "x", tier: "review" }),
        OKedAuthError,
      );
    });

    it("500 -> OKedBackendUnreachableError", async () => {
      status = 500;
      const client = new OKedClient({
        apiKey: "k",
        backendUrl: `http://127.0.0.1:${port}`,
        timeout: 2000,
      });
      await assert.rejects(
        () => client.approve({ action: "Bash", description: "x", tier: "review" }),
        OKedBackendUnreachableError,
      );
    });

    it("explicit deny returns normally (not thrown)", async () => {
      status = 200;
      const client = new OKedClient({
        apiKey: "k",
        backendUrl: `http://127.0.0.1:${port}`,
        timeout: 2000,
      });
      const r = await client.approve({
        action: "Bash",
        description: "x",
        tier: "review",
      });
      assert.equal(r.approved, false);
      assert.equal(r.decision, "denied");
    });
  });
});
