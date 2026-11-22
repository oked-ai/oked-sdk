import { strict as assert } from "node:assert";
import { applyPluginConfig } from "../bin/oked-openclaw.mjs";

const existing = {
  plugins: {
    allow: ["voice-call"],
    entries: {
      oked: { extra: true, minTier: "high_stakes" },
      other: { enabled: true },
    },
  },
};
const updated = applyPluginConfig(existing, {
  apiKey: "ok_test",
  minTier: "review",
  backendUrl: "https://api.oked.ai",
});
assert.equal(updated, existing);
assert.deepEqual(updated.plugins.allow, ["voice-call", "oked"]);
assert.equal(updated.plugins.entries.other.enabled, true);
assert.equal(updated.plugins.entries.oked.extra, true);
assert.equal(updated.plugins.entries.oked.enabled, true);
assert.equal(updated.plugins.entries.oked.apiKey, "ok_test");
assert.equal(updated.plugins.entries.oked.minTier, "review");

const empty = applyPluginConfig({}, {
  apiKey: "ok_new",
  minTier: "review",
  backendUrl: "https://api.oked.ai",
});
assert.deepEqual(empty.plugins.allow, ["oked"]);
assert.equal(empty.plugins.entries.oked.apiKey, "ok_new");
assert.equal(empty.plugins.entries.oked.enabled, true);

const again = applyPluginConfig(empty, {
  apiKey: "ok_new",
  minTier: "review",
  backendUrl: "https://api.oked.ai",
});
assert.deepEqual(again.plugins.allow, ["oked"]);

console.log("OK plugin allowlist config");
