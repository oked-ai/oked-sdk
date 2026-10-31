import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("a scan does not touch the network", () => {
  it("does not call fetch, http, https, net, or dns", async () => {
    const hits: string[] = [];
    const block = (name: string) => () => {
      hits.push(name);
      throw new Error(`network:${name}`);
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = block("fetch") as typeof fetch;
    mock.method(http, "request", block("http.request"));
    mock.method(http, "get", block("http.get"));
    mock.method(https, "request", block("https.request"));
    mock.method(https, "get", block("https.get"));
    mock.method(net, "connect", block("net.connect"));
    mock.method(net, "createConnection", block("net.createConnection"));
    mock.method(dns, "lookup", block("dns.lookup"));
    mock.method(dns, "resolve", block("dns.resolve"));
    const root = mkdtempSync(join(tmpdir(), "oked-scan-net-"));
    try {
      const { scan } = await import("../src/index.js");
      const report = await scan({
        root,
        explicitRoot: true,
        home: root,
        now: new Date("2026-10-31T00:00:00.000Z"),
      });
      assert.equal(report.localOnly, true);
      assert.equal(report.network, false);
      assert.equal(report.telemetry, false);
      assert.equal(report.totals.commands, 0);
      assert.deepEqual(hits, []);
    } finally {
      globalThis.fetch = previousFetch;
      mock.restoreAll();
    }
  });
});
