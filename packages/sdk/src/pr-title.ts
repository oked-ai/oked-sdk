import { lookupPrTitleWithGh } from "./pr-title-gh.js";

/**
 * Title of the PR that a card links to, when the command does not already
 * quote one. Pass the result to `describeFields()` as `prTitle`.
 *
 * A token uses the GitHub API and does not run gh. With no token, hosts that
 * ship the gh helper ask gh. The Claude Code plugin replaces that helper so
 * a missing token skips the lookup.
 */
export function lookupPrTitle(
  fields: Record<string, string> | undefined,
  timeoutMs = 3000,
  token?: string,
): Promise<string | undefined> {
  const link = fields?.Link;
  if (!link || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(link) || fields.Title?.includes('"')) {
    return Promise.resolve(undefined);
  }
  if (token) return lookupPrTitleWithToken(link, token, timeoutMs);
  return lookupPrTitleWithGh(link, timeoutMs);
}

async function lookupPrTitleWithToken(
  link: string,
  token: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(link);
  if (!match) return undefined;
  const url = `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "oked",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim().split("\n")[0] : "";
    return title || undefined;
  } catch {
    return undefined;
  }
}
