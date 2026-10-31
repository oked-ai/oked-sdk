// ClawHub publish metadata. No test runner. Fails if the package would not
// validate, if the public listing would label the internal service override,
// or if the release workflow could fail an npm publish when the token is absent.

import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(pkgDir, "openclaw.plugin.json"), "utf8"));

assert.equal(pkg.openclaw.compat.pluginApi, ">=2026.4.20");
assert.equal(pkg.openclaw.build.openclawVersion, "2026.4.20");
assert.equal(pkg.openclaw.install.clawhubSpec, "@oked/openclaw");
assert.equal(pkg.openclaw.install.npmSpec, "@oked/openclaw");
assert.equal(pkg.openclaw.install.defaultChoice, "clawhub");
assert.equal(pkg.openclaw.install.minHostVersion, ">=2026.4.20");
assert.equal(pkg.peerDependencies.openclaw, ">=2026.4.20");
assert.deepEqual(pkg.openclaw.extensions, ["./dist/index.js"]);
assert.ok(pkg.files.includes("assets"), "assets/icon.png must ship in the npm pack");
assert.ok(pkg.files.includes("openclaw.plugin.json"));

assert.deepEqual(manifest.categories, ["security"]);
assert.equal(manifest.id, "oked");
assert.equal(typeof manifest.configSchema.properties.backendUrl, "object");
assert.equal(manifest.uiHints.backendUrl, undefined);
assert.equal(JSON.stringify(manifest.uiHints).includes("Backend URL"), false);
for (const hint of Object.values(manifest.uiHints)) {
  const blob = JSON.stringify(hint);
  assert.equal(blob.includes("backendUrl"), false);
  assert.equal(blob.includes("OKED_BACKEND_URL"), false);
}

const icon = readFileSync(join(pkgDir, "assets", "icon.png"));
assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
assert.ok(icon.length <= 512 * 1024, `icon is ${icon.length} bytes`);

const packedRaw = execFileSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: pkgDir, encoding: "utf8" },
);
const packed = JSON.parse(packedRaw.slice(packedRaw.indexOf("[")));
const packedPaths = packed[0].files.map((file) => file.path);
for (const required of [
  "openclaw.plugin.json",
  "dist/index.js",
  "assets/icon.png",
  "README.md",
]) {
  assert.ok(packedPaths.includes(required), `npm pack missing ${required}`);
}
assert.equal(
  packedPaths.some((filePath) => filePath.startsWith("src/")),
  false,
  "published tarball must not include TypeScript source",
);

const publicDocs = [
  "README.md",
  "CHANGELOG.md",
  "RELEASING.md",
  "docs/hosts.md",
  "packages/openclaw/README.md",
  "packages/openclaw-cli/README.md",
];
for (const rel of publicDocs) {
  const text = readFileSync(join(repoRoot, rel), "utf8");
  assert.equal(text.includes("\u2014"), false, `${rel} contains an em dash`);
  assert.equal(text.includes("backendUrl"), false, `${rel} names backendUrl`);
  assert.equal(text.includes("OKED_BACKEND_URL"), false, `${rel} names OKED_BACKEND_URL`);
}

const openclawReadme = readFileSync(join(pkgDir, "README.md"), "utf8");
assert.ok(openclawReadme.includes("openclaw plugins install @oked/openclaw"));
assert.ok(openclawReadme.includes("npm install -g @oked/openclaw-cli"));
assert.ok(openclawReadme.includes("The iPhone app is coming soon."));

const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
assert.ok(rootReadme.includes("openclaw plugins install @oked/openclaw"));
const hosts = readFileSync(join(repoRoot, "docs/hosts.md"), "utf8");
assert.ok(hosts.includes("openclaw plugins install @oked/openclaw"));

const releasing = readFileSync(join(repoRoot, "RELEASING.md"), "utf8");
for (const needle of [
  "clawhub login",
  "clawhub publisher create oked",
  "clawhub package publish packages/openclaw --family code-plugin --owner oked",
  "clawhub package trusted-publisher set @oked/openclaw",
  "--workflow-filename publish.yml",
  "CLAWHUB_TOKEN",
  "contact@oked.ai",
]) {
  assert.ok(releasing.includes(needle), `RELEASING.md missing ${needle}`);
}

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const unreleased = changelog.split("## 0.6.22")[0];
assert.ok(unreleased.includes("openclaw plugins install @oked/openclaw"));
assert.ok(unreleased.includes("CLAWHUB_TOKEN"));

const workflow = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
assert.ok(
  workflow.includes(
    "CLAWHUB_TOKEN is not set. Skipping ClawHub publish for @oked/openclaw.",
  ),
);
assert.ok(workflow.includes("matrix.package == 'openclaw'"));
assert.ok(workflow.includes("--family code-plugin"));
assert.ok(workflow.includes("--owner oked"));
assert.ok(workflow.includes("clawhub@0.24.1"));
assert.equal(workflow.includes("clawhub login"), false);

console.log("OK ClawHub metadata");
