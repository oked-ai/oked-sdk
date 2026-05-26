#!/usr/bin/env node
// Builds self-contained release bundles for the CLI bins and writes a manifest
// describing them. Output goes into release/ at the repo root:
//
//   release/oked-cli.js
//   release/oked-hook.js
//   release/oked-openclaw.mjs
//   release/manifest.json
//
// The bundles are self-contained ESM files (all @oked/* deps inlined). The CI
// release workflow uploads them as assets on the GitHub Release for the tag,
// and updaters fetch them via the manifest.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const OUT = join(ROOT, "release");

const tag = process.env.RELEASE_TAG || process.argv[2] || "";
const version = (() => {
  const raw = readFileSync(join(ROOT, "packages/sdk/src/version.ts"), "utf-8");
  const m = raw.match(/SDK_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("Could not find SDK_VERSION in packages/sdk/src/version.ts");
  return m[1];
})();

const tagVersion = tag.replace(/^v/, "");
if (tagVersion && tagVersion !== version) {
  console.error(`Tag version (${tagVersion}) does not match SDK_VERSION (${version}).`);
  console.error(`Bump packages/sdk/src/version.ts before tagging.`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const targets = [
  {
    name: "oked-cli.js",
    entry: join(ROOT, "packages/claude-code/src/cli.ts"),
    format: "esm",
  },
  {
    name: "oked-hook.js",
    entry: join(ROOT, "packages/claude-code/src/hook.ts"),
    format: "esm",
  },
  {
    name: "oked-openclaw.mjs",
    entry: join(ROOT, "packages/openclaw-cli/lib/oked-openclaw.mjs"),
    format: "esm",
  },
  {
    // Detached worker invoked by triggerBackgroundUpdate() from any managed
    // bin. Lives at ~/.oked/current/oked-update-worker.js after install.
    name: "oked-update-worker.js",
    entry: join(ROOT, "packages/sdk/src/update-worker.ts"),
    format: "esm",
  },
];

const files = [];
for (const t of targets) {
  const outfile = join(OUT, t.name);
  console.log(`bundling ${t.name}...`);
  await build({
    entryPoints: [t.entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node18",
    format: t.format,
    // No shebang: bundles are loaded via dynamic import() from the shims,
    // not exec'd directly, so a `#!` line would be a syntax error.
    // Keep Node built-ins external; bundle everything else (including @oked/sdk).
    external: [],
    // node: prefix means built-ins.
    packages: undefined,
    legalComments: "none",
    minify: false,
    sourcemap: false,
  });
  const buf = readFileSync(outfile);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const size = statSync(outfile).size;
  files.push({
    name: t.name,
    sha256,
    size,
    // Final URL is filled in by the release workflow once the tag is known.
    url: `https://github.com/oked-ai/oked-sdk/releases/download/v${version}/${t.name}`,
  });
  console.log(`  ${t.name}  ${sha256}  (${size} bytes)`);
}

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  files,
};
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nWrote ${join(OUT, "manifest.json")} for v${version}`);
