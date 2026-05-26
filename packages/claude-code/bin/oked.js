#!/usr/bin/env node
// Shim: prefer the managed install at ~/.oked/current/oked-cli.js, fall back
// to the npm-installed bundle in ../dist/cli.js. The shim itself is stable;
// real CLI logic is in the target file.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.OKED_HOME || join(homedir(), ".oked");
const managed = join(home, "current", "oked-cli.js");
const fallback = new URL("../dist/cli.js", import.meta.url);

try {
  if (existsSync(managed)) {
    await import(pathToFileURL(managed).href);
  } else {
    await import(fallback.href);
  }
} catch (err) {
  // Managed bundle failed to load (corrupt download, ABI break, etc.).
  // Fall back to the bundled version so the user is never stuck.
  if (existsSync(managed)) {
    process.stderr.write(`[OKed] managed install failed (${err && err.message}); using bundled version\n`);
    await import(fallback.href);
  } else {
    throw err;
  }
}
