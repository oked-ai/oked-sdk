import { execFile } from "node:child_process";

/**
 * Title of the PR that a card links to, from GitHub (`gh pr view`), for a card
 * whose command does not say it. Pass the result to `describeFields()` as
 * `prTitle`. Returns undefined when the card needs no title, or when gh is not
 * installed, not signed in, or slower than `timeoutMs`.
 */
export function lookupPrTitle(
  fields: Record<string, string> | undefined,
  timeoutMs = 3000,
): Promise<string | undefined> {
  const link = fields?.Link;
  if (!link || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(link) || fields.Title?.includes('"')) {
    return Promise.resolve(undefined);
  }
  return new Promise((done) => {
    execFile(
      "gh",
      ["pr", "view", link, "--json", "title", "--jq", ".title"],
      { timeout: timeoutMs, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (err, stdout) => done(err ? undefined : stdout.trim().split("\n")[0] || undefined),
    );
  });
}
