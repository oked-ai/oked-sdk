#!/usr/bin/env node
// Shim: prefer the managed install at ~/.oked/current/oked-openclaw.mjs,
// fall back to the npm-installed body in ../lib/oked-openclaw.mjs.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.OKED_HOME || join(homedir(), ".oked");
const managed = join(home, "current", "oked-openclaw.mjs");
const fallback = new URL("../lib/oked-openclaw.mjs", import.meta.url);

try {
  if (existsSync(managed)) {
    await import(pathToFileURL(managed).href);
  } else {
    await import(fallback.href);
  }
} catch (err) {
  if (existsSync(managed)) {
    process.stderr.write(`[OKed] managed install failed (${err && err.message}); using bundled version\n`);
    await import(fallback.href);
  } else {
    throw err;
  }
}
