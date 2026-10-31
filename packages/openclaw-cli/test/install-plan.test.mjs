import { strict as assert } from "node:assert";
import {
  NPM_INSTALL_HINT,
  resolvePluginInstall,
  runInstallAttempts,
} from "../bin/oked-openclaw.mjs";

const linked = resolvePluginInstall({
  pluginPath: "/tmp/packages/openclaw",
  alreadyInstalled: true,
});
assert.equal(linked.kind, "link");
assert.deepEqual(linked.args, [
  "plugins",
  "install",
  "--link",
  "/tmp/packages/openclaw",
]);
assert.deepEqual(linked.fallbacks, []);

const already = resolvePluginInstall({ pluginPath: null, alreadyInstalled: true });
assert.equal(already.kind, "skip");
assert.deepEqual(already.args, []);
assert.deepEqual(already.fallbacks, []);

const clawhub = resolvePluginInstall({ pluginPath: null, alreadyInstalled: false });
assert.equal(clawhub.kind, "clawhub");
assert.deepEqual(clawhub.args, ["plugins", "install", "@oked/openclaw"]);
assert.deepEqual(clawhub.fallbacks, [["plugins", "install", "npm:@oked/openclaw"]]);

const attempts = [clawhub.args, ...clawhub.fallbacks];

const clawhubOk = await runInstallAttempts(attempts, async (args) => {
  assert.deepEqual(args, ["plugins", "install", "@oked/openclaw"]);
  return 0;
});
assert.equal(clawhubOk.ok, true);
assert.equal(clawhubOk.code, 0);
assert.equal(clawhubOk.hint, null);
assert.equal(clawhubOk.calls.length, 1);
assert.equal(clawhubOk.calls[0].code, 0);

const seen = [];
const npmOk = await runInstallAttempts(attempts, async (args) => {
  seen.push(args.join(" "));
  return seen.length === 1 ? 2 : 0;
});
assert.deepEqual(seen, [
  "plugins install @oked/openclaw",
  "plugins install npm:@oked/openclaw",
]);
assert.equal(npmOk.ok, true);
assert.equal(npmOk.code, 0);
assert.equal(npmOk.calls.length, 2);
assert.equal(npmOk.calls[0].code, 2);
assert.equal(npmOk.calls[1].code, 0);

const bothFail = await runInstallAttempts(attempts, async () => 4);
assert.equal(bothFail.ok, false);
assert.equal(bothFail.code, 4);
assert.equal(bothFail.calls.length, 2);
assert.deepEqual(
  bothFail.calls.map((call) => call.args),
  [
    ["plugins", "install", "@oked/openclaw"],
    ["plugins", "install", "npm:@oked/openclaw"],
  ],
);
assert.equal(bothFail.hint, NPM_INSTALL_HINT);
assert.equal(bothFail.hint, "openclaw plugins install npm:@oked/openclaw");

const linkFail = await runInstallAttempts([linked.args, ...linked.fallbacks], async () => 9);
assert.equal(linkFail.ok, false);
assert.equal(linkFail.calls.length, 1);
assert.equal(linkFail.hint, null);

console.log("OK install plan");
