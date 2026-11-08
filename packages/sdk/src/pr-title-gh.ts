import { execFile } from "node:child_process";

/**
 * Pull request title from the gh CLI, which uses the login already stored
 * for that command. The Claude Code plugin bundle replaces this module and
 * does not call gh.
 */
export function lookupPrTitleWithGh(link: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      "gh",
      ["pr", "view", link, "--json", "title", "--jq", ".title"],
      { timeout: timeoutMs, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (err, stdout) => done(err ? undefined : stdout.trim().split("\n")[0] || undefined),
    );
  });
}
