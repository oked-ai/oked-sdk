import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  runUpdate,
  rollback,
  getCurrentManagedVersion,
  isNewerVersion,
  readUpdateState,
  writeUpdateState,
} from "../src/update.js";

function withOkedHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oked-test-"));
  const prev = process.env.OKED_HOME;
  process.env.OKED_HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (prev === undefined) delete process.env.OKED_HOME;
    else process.env.OKED_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
}

function startManifestServer(files: Record<string, Buffer>, manifest: object) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    const name = url.pathname.replace(/^\//, "");
    if (files[name]) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(files[name]);
      return;
    }
    res.writeHead(404).end("not found");
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;
      resolve({
        url: `${base}/manifest.json`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

test("isNewerVersion", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
});

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test("runUpdate downloads, verifies, atomically swaps current", async () => {
  await withOkedHome(async () => {
    const fileBody = Buffer.from("export const HELLO = 1;\n");
    const sha = createHash("sha256").update(fileBody).digest("hex");
    const port = await pickPort();
    const manifest = {
      version: "9.9.9",
      files: [
        { name: "oked-cli.js", url: `http://127.0.0.1:${port}/oked-cli.js`, sha256: sha, size: fileBody.length },
      ],
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/manifest.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
      } else if (url.pathname === "/oked-cli.js") {
        res.writeHead(200).end(fileBody);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    try {
      const result = await runUpdate({
        force: true,
        manifestUrl: `http://127.0.0.1:${port}/manifest.json`,
      });
      assert.equal(result.status, "updated", result.error);
      assert.equal(result.manifestVersion, "9.9.9");
      assert.equal(getCurrentManagedVersion(), "9.9.9");
      const dest = join(process.env.OKED_HOME!, "current", "oked-cli.js");
      assert.equal(existsSync(dest), true);
      assert.equal(readFileSync(dest, "utf-8"), fileBody.toString());
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test("runUpdate rejects SHA-256 mismatch", async () => {
  await withOkedHome(async () => {
    const fileBody = Buffer.from("export const HELLO = 2;\n");
    const bogusSha = "0".repeat(64);
    const manifest = {
      version: "9.9.9",
      files: [{ name: "oked-cli.js", url: "PLACEHOLDER", sha256: bogusSha }],
    };
    const server = await startManifestServer({ "oked-cli.js": fileBody }, manifest);
    const base = server.url.replace(/\/manifest.json$/, "");
    manifest.files[0].url = `${base}/oked-cli.js`;
    try {
      const result = await runUpdate({ force: true, manifestUrl: server.url });
      assert.equal(result.status, "error");
      assert.match(result.error!, /SHA-256 mismatch/);
      assert.equal(getCurrentManagedVersion(), null, "no current link should be created");
    } finally {
      await server.close();
    }
  });
});

test("runUpdate returns up-to-date when manifest version equals running", async () => {
  await withOkedHome(async () => {
    const manifest = { version: "0.0.1", files: [] };
    const server = await startManifestServer({}, manifest);
    try {
      // Bootstrap a current install at v999.999.999 so the manifest looks older.
      const home = process.env.OKED_HOME!;
      const vdir = join(home, "versions", "999.999.999");
      mkdirSync(vdir, { recursive: true });
      writeFileSync(join(vdir, "VERSION"), "999.999.999\n");
      const { symlinkSync } = await import("node:fs");
      symlinkSync(vdir, join(home, "current"), "dir");
      const result = await runUpdate({ force: true, manifestUrl: server.url });
      assert.equal(result.status, "up-to-date");
    } finally {
      await server.close();
    }
  });
});

test("rollback reverts current to previous version", async () => {
  await withOkedHome(async () => {
    const home = process.env.OKED_HOME!;
    for (const v of ["0.1.0", "0.2.0"]) {
      const vdir = join(home, "versions", v);
      mkdirSync(vdir, { recursive: true });
      writeFileSync(join(vdir, "VERSION"), v + "\n");
    }
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(home, "versions", "0.2.0"), join(home, "current"), "dir");
    assert.equal(getCurrentManagedVersion(), "0.2.0");
    const r = rollback();
    assert.equal(r.from, "0.2.0");
    assert.equal(r.to, "0.1.0");
    assert.equal(getCurrentManagedVersion(), "0.1.0");
  });
});

test("update state read/write merges fields", async () => {
  await withOkedHome(async () => {
    writeUpdateState({ lastCheck: 1, latestKnownVersion: "9.9.9" });
    writeUpdateState({ lastCheck: 2 });
    const s = readUpdateState();
    assert.equal(s.lastCheck, 2);
    assert.equal(s.latestKnownVersion, "9.9.9");
  });
});

test("pinned version blocks non-forced updates", async () => {
  await withOkedHome(async () => {
    writeUpdateState({ pinnedVersion: "0.1.0" });
    const result = await runUpdate({});
    assert.equal(result.status, "pinned");
  });
});

test("recent lastCheck skips update", async () => {
  await withOkedHome(async () => {
    writeUpdateState({ lastCheck: Date.now() });
    const result = await runUpdate({});
    assert.equal(result.status, "skipped");
  });
});
