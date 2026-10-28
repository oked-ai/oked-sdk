import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const CLIENT_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const CLIENT_ID = `@oked/cursor@${CLIENT_VERSION}`;
export const PAIR_COMMAND = "oked-cursor init";
export const UNINSTALL_COMMAND = "oked-cursor uninstall";
