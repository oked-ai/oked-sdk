import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { OKedClient, OKedBackendUnreachableError } from "../src/index.js";

// A request the backend accepted and then held past a timer is a timeout
// (deny), never an outage. If it were classified as an outage, degraded mode
// would ALLOW a review-tier action that no human ever approved.

type Mode = "silent" | "heartbeat-then-hold" | "heartbeat-then-answer" | "504" | "502";

describe("OKedClient.approve held requests", () => {
  let server: Server;
  let port = 0;
  let mode: Mode = "silent";
  const open: ServerResponse[] = [];

  before(async () => {
    server = createServer((_req, res) => {
      open.push(res);
      if (mode === "silent") return; // never send headers
      if (mode === "504" || mode === "502") {
        res.writeHead(Number(mode));
        res.end("gateway");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(" ");
      const beat = setInterval(() => res.write(" "), 50);
      if (mode === "heartbeat-then-answer") {
        setTimeout(() => {
          clearInterval(beat);
          res.end(JSON.stringify({ approval_id: "a1", decision: "approved", status: "approved" }));
        }, 250);
      } else {
        res.on("close", () => clearInterval(beat));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    for (const res of open) res.destroy();
    server.close();
  });

  const client = (timeout: number) =>
    new OKedClient({ apiKey: "k", backendUrl: `http://127.0.0.1:${port}`, timeout });
  const ask = (c: OKedClient) => c.approve({ action: "Bash", description: "x", tier: "review" });

  it("no headers before our abort -> decision timeout, not an outage", async () => {
    mode = "silent";
    const r = await ask(client(300));
    assert.deepEqual(r, { approved: false, approval_id: null, decision: "timeout" });
  });

  it("headers + heartbeats, body never finishes -> decision timeout", async () => {
    mode = "heartbeat-then-hold";
    const r = await ask(client(300));
    assert.equal(r.approved, false);
    assert.equal(r.decision, "timeout");
  });

  it("headers + heartbeats, then the decision -> parsed despite leading whitespace", async () => {
    mode = "heartbeat-then-answer";
    const r = await ask(client(5000));
    assert.equal(r.approved, true);
    assert.equal(r.approval_id, "a1");
  });

  it("504 from a gateway -> decision timeout", async () => {
    mode = "504";
    const r = await ask(client(2000));
    assert.equal(r.decision, "timeout");
    assert.equal(r.approved, false);
  });

  it("502 is still an outage", async () => {
    mode = "502";
    await assert.rejects(() => ask(client(2000)), OKedBackendUnreachableError);
  });
});
