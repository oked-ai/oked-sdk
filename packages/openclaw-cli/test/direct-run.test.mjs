// npm and npx launch this bin through a symlink. 0.6.25 and 0.6.26 compared
// import.meta.url to process.argv[1], missed the symlink, and exited 0 with
// no output. This runs the CLI the same way and checks --help and init.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/oked-openclaw.mjs", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "oked-cli-link-"));
const link = path.join(dir, "oked-openclaw");
symlinkSync(path.relative(dir, cli), link);

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [link, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: dir,
      HOME: dir,
      USERPROFILE: dir,
      ...extraEnv,
    },
  });
}

const direct = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
assert.equal(direct.status, 0, direct.stderr);
assert.match(direct.stdout, /Usage:/);
assert.match(direct.stdout, /oked-openclaw init/);

const help = run(["--help"]);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:/);
assert.match(help.stdout, /oked-openclaw init/);
assert.match(help.stdout, /oked-openclaw status/);
assert.ok(help.stdout.length > 0, "symlink --help printed nothing");

const init = run(["init"]);
assert.notEqual(init.status, 0);
assert.match(init.stdout, /OKed -> OpenClaw plugin installer/);
assert.match(`${init.stdout}\n${init.stderr}`, /openclaw/);
assert.ok(init.stdout.length > 0, "symlink init printed nothing");

console.log("OK cli direct run through a symlink");
