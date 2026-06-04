#!/usr/bin/env node
// Lockstep version bump for every @oked/* package.
//
// Sets `version` in all packages/*/package.json to the target, AND rewrites
// every internal @oked/* dependency pin (deps / devDeps / peerDeps / optional)
// to that exact version. This kills the old "bump the pinned dep by hand" step
// (RELEASING.md), the one place a release could silently ship a package against
// the wrong SDK.
//
// Usage:
//   node scripts/bump-version.mjs <patch|minor|major>
//   node scripts/bump-version.mjs <explicit version, e.g. 0.2.0 or 0.2.0-beta.1>
//
// Prereleases are passed explicitly (e.g. 0.2.0-beta.1) and publish under the
// `next` dist-tag; see .github/workflows/publish.yml.

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKGS_DIR = join(ROOT, "packages");
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

// Load every package.json under packages/*.
const pkgs = readdirSync(PKGS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const path = join(PKGS_DIR, d.name, "package.json");
    return { path, json: JSON.parse(readFileSync(path, "utf-8")) };
  })
  .filter((p) => p.json.name && p.json.version);

if (pkgs.length === 0) {
  console.error("no packages found under packages/*");
  process.exit(1);
}

const internalNames = new Set(pkgs.map((p) => p.json.name));

// Enforce the lockstep invariant: every package must already share one version.
const versions = [...new Set(pkgs.map((p) => p.json.version))];
if (versions.length > 1) {
  console.error(`packages are not in lockstep (found ${versions.join(", ")}); fix by hand first`);
  process.exit(1);
}
const current = versions[0];

function computeNext(cur, spec) {
  if (["patch", "minor", "major"].includes(spec)) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cur);
    if (!m) {
      console.error(`cannot ${spec}-bump non-numeric version "${cur}"; pass an explicit version`);
      process.exit(1);
    }
    let [major, minor, patch] = m.slice(1).map(Number);
    if (spec === "major") (major += 1), (minor = 0), (patch = 0);
    else if (spec === "minor") (minor += 1), (patch = 0);
    else patch += 1;
    return `${major}.${minor}.${patch}`;
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) {
    console.error(`"${spec}" is not patch|minor|major or a valid semver version`);
    process.exit(1);
  }
  return spec;
}

const next = computeNext(current, arg);
if (next === current) {
  console.error(`target version ${next} equals current; nothing to do`);
  process.exit(1);
}

for (const { path, json } of pkgs) {
  json.version = next;
  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (internalNames.has(dep)) deps[dep] = next; // exact pin, lockstep
    }
  }
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

console.log(`bumped ${pkgs.length} packages: ${current} -> ${next}`);
console.log("internal @oked/* pins rewritten to exact " + next);
console.log("\nnext steps:");
console.log(`  npm install                       # refresh package-lock`);
console.log(`  git commit -am "Release v${next}"`);
console.log(`  git tag v${next} && git push origin main --tags`);
