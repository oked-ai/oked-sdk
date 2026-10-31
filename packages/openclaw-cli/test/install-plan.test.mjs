import { strict as assert } from "node:assert";
import { resolvePluginInstall } from "../bin/oked-openclaw.mjs";

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

const already = resolvePluginInstall({ pluginPath: null, alreadyInstalled: true });
assert.equal(already.kind, "skip");
assert.deepEqual(already.args, []);

const clawhub = resolvePluginInstall({ pluginPath: null, alreadyInstalled: false });
assert.equal(clawhub.kind, "clawhub");
assert.deepEqual(clawhub.args, ["plugins", "install", "@oked/openclaw"]);

console.log("OK install plan");
