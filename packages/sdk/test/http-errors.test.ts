import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  OKedClient,
  OKedAuthError,
  OKedBackendUnreachableError,
  OKedHttpError,
  OKedTooManyPendingError,
} from "../src/index.js";

// What approve() makes of each kind of reply. An outage (the backend is gone,
// or something that is not the backend answers) must be an
// OKedBackendUnreachableError, so degraded mode applies. Other errors keep
// their HTTP status and a short detail, so the hook can show the real cause.

type Reply = { status: number; headers?: Record<string, string>; body: string };

describe("OKedClient.approve error replies", () => {
  let server: Server;
  let port = 0;
  let reply: Reply = { status: 200, body: "{}" };

  before(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const approve = () =>
    new OKedClient({ apiKey: "k", backendUrl: `http://127.0.0.1:${port}`, requireReceipt: false, timeout: 5000 }).approve({
      action: "Bash",
      description: "rm -rf build",
      tier: "high_stakes",
    });

  it("Railway 'Application not found' (x-railway-fallback) is unreachable, with the status", async () => {
    reply = {
      status: 404,
      headers: { "x-railway-fallback": "true" },
      body: JSON.stringify({ status: "error", code: 404, message: "Application not found", request_id: "abc" }),
    };
    await assert.rejects(approve(), (e: unknown) => {
      assert.ok(e instanceof OKedBackendUnreachableError);
      assert.equal(e.status, 404);
      assert.match(e.message, /HTTP 404/);
      assert.match(e.message, /application not found/i);
      return true;
    });
  });

  it("'Application not found' without the header is also unreachable", async () => {
    reply = { status: 404, body: JSON.stringify({ message: "Application not found" }) };
    await assert.rejects(approve(), OKedBackendUnreachableError);
  });

  it("an error page that is not JSON is unreachable, with a short one-line detail", async () => {
    reply = { status: 404, headers: { "Content-Type": "text/html" }, body: "<html><body><h1>Not Found</h1>" + "x".repeat(1000) + "</body></html>" };
    await assert.rejects(approve(), (e: unknown) => {
      assert.ok(e instanceof OKedBackendUnreachableError);
      assert.equal(e.status, 404);
      assert.match(e.message, /not JSON: Not Found/);
      assert.ok(e.message.length < 320, "the detail is cut short");
      assert.ok(!e.message.includes("<h1>"), "no HTML tags");
      return true;
    });
  });

  it("HTTP 200 with a body that is not JSON is unreachable", async () => {
    reply = { status: 200, headers: { "Content-Type": "text/html" }, body: "<html>captive portal</html>" };
    await assert.rejects(approve(), (e: unknown) => {
      assert.ok(e instanceof OKedBackendUnreachableError);
      assert.equal(e.status, 200);
      assert.match(e.message, /not JSON \(content-type text\/html\)/);
      return true;
    });
  });

  it("429 'too many pending approvals' has its own clear error", async () => {
    reply = { status: 429, body: JSON.stringify({ error: "too many pending approvals for this operator" }) };
    await assert.rejects(approve(), (e: unknown) => {
      assert.ok(e instanceof OKedTooManyPendingError);
      assert.equal(e.status, 429);
      assert.match(e.message, /too many approvals are waiting for your decision/);
      assert.match(e.message, /Approve or deny them/);
      assert.match(e.message, /HTTP 429: too many pending approvals for this operator/);
      return true;
    });
  });

  it("another 4xx keeps its status and the backend's error text", async () => {
    reply = { status: 400, body: JSON.stringify({ error: "action is required" }) };
    await assert.rejects(approve(), (e: unknown) => {
      assert.ok(e instanceof OKedHttpError);
      assert.equal(e.status, 400);
      assert.equal(e.detail, "action is required");
      assert.equal(e.message, "OKed backend error HTTP 400: action is required");
      return true;
    });
  });

  it("401 with a JSON body is still an auth error", async () => {
    reply = { status: 401, body: JSON.stringify({ message: "API key required" }) };
    await assert.rejects(approve(), OKedAuthError);
  });

  it("5xx with JSON is unreachable, with the status", async () => {
    reply = { status: 503, body: JSON.stringify({ error: "down" }) };
    await assert.rejects(approve(), (e: unknown) => {
      assert.ok(e instanceof OKedBackendUnreachableError);
      assert.equal(e.status, 503);
      return true;
    });
  });

  it("a normal JSON decision still works", async () => {
    reply = { status: 200, body: "  " + JSON.stringify({ approval_id: "a1", decision: "denied", status: "denied" }) };
    const r = await approve();
    assert.deepEqual([r.approved, r.decision, r.approval_id], [false, "denied", "a1"]);
  });
});

describe("OKedClient.approve: auth wins over the body format", () => {
  it("401 and 403 with a body that is not JSON are auth errors, never an outage", async () => {
    for (const status of [401, 403]) {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(status, { "Content-Type": "text/html", "x-railway-fallback": "true" });
          res.end("<html>nope</html>");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      try {
        const c = new OKedClient({ apiKey: "k", backendUrl: `http://127.0.0.1:${port}`, requireReceipt: false, timeout: 5000 });
        await assert.rejects(c.approve({ action: "Bash", description: "x", tier: "review" }), OKedAuthError);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
  });
});
