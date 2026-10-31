import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OKedClient,
  effectiveMode,
  formatWatchReport,
  parseOkedMode,
  readWatchLog,
  recordWouldHavePaused,
  resolveOkedMode,
  saveOkedMode,
} from "../src/index.js";

function withHome(fn: (home: string) => void): void {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevMode = process.env.OKED_MODE;
  const prevLog = process.env.OKED_WATCH_LOG;
  const home = mkdtempSync(join(tmpdir(), "oked-watch-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OKED_MODE;
  delete process.env.OKED_WATCH_LOG;
  try {
    fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevMode === undefined) delete process.env.OKED_MODE;
    else process.env.OKED_MODE = prevMode;
    if (prevLog === undefined) delete process.env.OKED_WATCH_LOG;
    else process.env.OKED_WATCH_LOG = prevLog;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("resolveOkedMode", () => {
  it("defaults to enforce and lets an explicit value and OKED_MODE win", () => {
    withHome((home) => {
      assert.equal(parseOkedMode("banana"), undefined);
      assert.equal(resolveOkedMode(), "enforce");
      assert.equal(new OKedClient({ apiKey: "ok_test" }).mode, "enforce");
      mkdirSync(join(home, ".oked"), { recursive: true });
      writeFileSync(join(home, ".oked", "config.json"), JSON.stringify({ mode: "watch", apiKey: "ok_file" }));
      assert.equal(resolveOkedMode(), "watch");
      assert.equal(new OKedClient({ apiKey: "ok_test" }).mode, "watch");
      process.env.OKED_MODE = "enforce";
      assert.equal(resolveOkedMode(), "enforce");
      assert.equal(resolveOkedMode("watch"), "watch");
      assert.equal(new OKedClient({ apiKey: "ok_test", mode: "watch" }).mode, "watch");
      assert.equal(effectiveMode(undefined, "enforce"), "enforce");
      assert.equal(effectiveMode("watch", "enforce"), "watch");
      delete process.env.OKED_MODE;
      saveOkedMode("enforce");
      const saved = JSON.parse(readFileSync(join(home, ".oked", "config.json"), "utf8"));
      assert.equal(saved.mode, "enforce");
      assert.equal(saved.apiKey, "ok_file");
    });
  });
});

describe("watch log", () => {
  it("stores the pause, not the command, and the report says what was not sent", () => {
    withHome((home) => {
      const path = join(home, "watch.log");
      process.env.OKED_WATCH_LOG = path;
      recordWouldHavePaused({
        tool: "Bash",
        tier: "high_stakes",
        client: "@oked/claude-code@test",
        source: "claude-code",
        reason: "would have paused",
      });
      const text = readFileSync(path, "utf8");
      const line = JSON.parse(text.trim());
      assert.equal(line.outcome, "would_have_paused");
      assert.equal(line.tool, "Bash");
      assert.equal(line.tier, "high_stakes");
      assert.equal(line.reason, "would have paused");
      assert.deepEqual(Object.keys(line).sort(), ["client", "outcome", "reason", "source", "tier", "tool", "ts"]);
      assert.ok(!text.includes("rm -rf"));
      const report = formatWatchReport(path);
      assert.match(report, /Would have paused: 1/);
      assert.match(report, /high_stakes {2}1/);
      assert.match(report, /Not stored: the command/);
      assert.match(report, /Not sent: the action/);
      assert.doesNotMatch(report, /OKED_BACKEND_URL|backendUrl/);
      const { entries, unparsable } = readWatchLog(path);
      assert.equal(entries.length, 1);
      assert.equal(unparsable, 0);
    });
  });
});
