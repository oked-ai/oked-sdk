import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point $HOME / %USERPROFILE% at a throwaway dir BEFORE the SDK loads, so the
// on-disk throttle file (~/.oked/heartbeat.json) lands there. libuv's
// homedir() consults these env vars first, so this redirects config.ts's
// module-level path resolution. Hence the dynamic imports below.
const home = mkdtempSync(join(tmpdir(), "oked-hb-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.OKED_API_KEY;
delete process.env.OKED_BACKEND_URL;
delete process.env.OKED_HEARTBEAT_INTERVAL;

const { OKedClient } = await import("../src/index.js");
const { OKED_HEARTBEAT_PATH } = await import("../src/config.js");

const BACKEND = "http://hb.test";
const KEY = "ok_test_key";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let calls: Call[];
let respond: () => Promise<any>;
const realFetch = globalThis.fetch;

function client(overrides?: Record<string, unknown>) {
  return new OKedClient({
    apiKey: KEY,
    backendUrl: BACKEND,
    heartbeatIntervalMs: 60_000,
    ...overrides,
  });
}

/** Force the throttle to think the last ping was long ago. */
function ageOutStamps(): void {
  const stamps = JSON.parse(readFileSync(OKED_HEARTBEAT_PATH, "utf-8"));
  for (const k of Object.keys(stamps)) stamps[k] = 0;
  writeFileSync(OKED_HEARTBEAT_PATH, JSON.stringify(stamps));
}

beforeEach(() => {
  if (existsSync(OKED_HEARTBEAT_PATH)) rmSync(OKED_HEARTBEAT_PATH);
  calls = [];
  respond = async () => ({ ok: true, status: 204 });
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OKedClient.heartbeat", () => {
  it("sends a POST to /api/v1/heartbeat with the Bearer key and writes the stamp", async () => {
    await client().heartbeat();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BACKEND}/api/v1/heartbeat`);
    assert.equal(calls[0].init?.method, "POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${KEY}`);
    assert.ok(existsSync(OKED_HEARTBEAT_PATH));
  });

  it("does not send again within the throttle interval", async () => {
    await client().heartbeat();
    await client().heartbeat();
    await client().heartbeat();
    assert.equal(calls.length, 1);
  });

  it("sends again once the stamp is older than the interval", async () => {
    await client().heartbeat();
    assert.equal(calls.length, 1);
    ageOutStamps();
    await client().heartbeat();
    assert.equal(calls.length, 2);
  });

  it("does nothing (no fetch) when there is no API key", async () => {
    await client({ apiKey: "" }).heartbeat();
    assert.equal(calls.length, 0);
  });

  it("never throws and does not write the stamp when the request rejects", async () => {
    respond = async () => {
      throw new Error("network down");
    };
    await client().heartbeat(); // must not throw
    assert.equal(calls.length, 1);
    assert.equal(existsSync(OKED_HEARTBEAT_PATH), false);
  });

  it("does not write the stamp on a non-ok response, so it retries next call", async () => {
    respond = async () => ({ ok: false, status: 500 });
    await client().heartbeat();
    assert.equal(existsSync(OKED_HEARTBEAT_PATH), false);
    // Next call retries (not throttled) and now succeeds.
    respond = async () => ({ ok: true, status: 204 });
    await client().heartbeat();
    assert.equal(calls.length, 2);
    assert.ok(existsSync(OKED_HEARTBEAT_PATH));
  });
});
