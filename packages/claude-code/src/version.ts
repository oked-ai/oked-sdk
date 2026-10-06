import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Derived from this package's package.json at runtime so the version the
// backend sees (client_version, receipts' requester.client) can never drift
// from what's actually shipped. From dist/*.js, package.json sits one dir up.
export const CLIENT_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const CLIENT_ID = `@oked/claude-code@${CLIENT_VERSION}`;
