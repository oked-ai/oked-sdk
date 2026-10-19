/**
 * Context translation - converts raw tool calls into human-readable
 * approvals. Output is a sentence-shaped Rendered value: title + optional
 * subline + optional body (quoted block) + optional footnote.
 *
 * Surfaces (Telegram, dashboard) consume Title/Subline/Body/Footnote keys
 * from the `fields` payload. `describe()` returns just the title for
 * backwards-compatible single-line consumers (audit logs, SMS).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { blankTextCommandArgs, classify, extractShellWriteOps, splitTopLevel, stripCodeHeredocBodies, stripInlineScriptBodies } from "./classify.js";
import { TIER_ORDER } from "./degraded.js";

const BODY_PREVIEW_MAX = 200;
const COMMAND_INLINE_MAX = 50;
const DIFF_HUNK_MAX_LINES = 10;

import type { OperationKind } from "./kinds.js";

export interface Rendered {
  title: string;        // operation label, e.g. "Create file", "Drop table"
  target?: string;      // primary target rendered on its own line in mono
  annotation?: string;  // small italic suffix to the target line, e.g. "(11 B)"
  subline?: string;
  body?: string;
  footnote?: string;
  kind: OperationKind;  // stable analytics category
}

/** Optional caller context. `cwd` lets describers read local files (e.g. the
 *  package.json behind `npm publish`) to show what an action will touch. */
export interface DescribeContext {
  cwd?: string;
}

export function describe(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: DescribeContext = {}
): string {
  // Single-line consumers (audit logs, SMS) get title + target inlined.
  const r = summarize(toolName, toolInput, ctx);
  if (r.target) {
    // Reorder phrasing for "Delete X recursively" / "Force push branch to remote"
    if (r.title === "Delete file recursively") return `Delete ${r.target} recursively`;
    if (/^Delete \d+ files/.test(r.title)) return r.title;
    if (/^(Drop|Truncate|Delete .* from) \d+/.test(r.title)) return r.title;
    if (r.title === "Push" || r.title === "Force push") return `${r.title} ${r.target}`;
    return `${r.title} ${r.target}`;
  }
  return r.title;
}

export function describeFields(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: DescribeContext = {}
): Record<string, string> | null {
  const r = summarize(toolName, toolInput, ctx);
  const out: Record<string, string> = { Title: r.title, Kind: r.kind };
  if (r.target) out.Target = r.target;
  if (r.annotation) out.Annotation = r.annotation;
  if (r.subline) out.Subline = r.subline;
  if (r.body) out.Body = r.body;
  if (r.footnote) out.Footnote = r.footnote;
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ───────────────────────────────────────────────────────────────────────

function summarize(toolName: string, toolInput: Record<string, unknown>, ctx: DescribeContext): Rendered {
  const fileSizeBytes = typeof toolInput._file_size_bytes === "number" ? toolInput._file_size_bytes : undefined;
  switch (toolName) {
    case "Bash":
      return summarizeBash((toolInput.command as string) || "", fileSizeBytes, ctx.cwd);
    case "Write":
      return summarizeWrite(toolInput);
    case "Edit":
      return summarizeEdit(toolInput);
    case "NotebookEdit":
      return summarizeNotebookEdit(toolInput);
    case "Agent":
      return summarizeAgent(toolInput);
  }

  const session = summarizeSessionTool(toolName, toolInput);
  if (session) return session;

  if (toolName.startsWith("mcp__")) {
    return summarizeMcp(toolName, toolInput);
  }

  // send_email tool name without mcp__ prefix
  if (toolName === "send_email") {
    return summarizeEmail(toolInput);
  }

  // Shell-exec wrappers: signature is a string command/cmd field
  const shellCommand = (toolInput.command ?? toolInput.cmd) as unknown;
  if (typeof shellCommand === "string") {
    return summarizeBash(shellCommand, fileSizeBytes);
  }

  // File-write wrappers: signature is a path + content/data string
  const writePath = (toolInput.file_path ?? toolInput.path) as unknown;
  const writeContent = (toolInput.content ?? toolInput.data ?? toolInput.body) as unknown;
  if (typeof writePath === "string" && typeof writeContent === "string") {
    return summarizeWrite({ file_path: writePath, content: writeContent });
  }

  return summarizeFallback(toolName, toolInput);
}

// ───────────────────────────────────────────────────────────────────────
// Bash / shell — semantic rerendering
// ───────────────────────────────────────────────────────────────────────

/**
 * A curl/wget that uses a mutating method (POST/PUT/PATCH/DELETE) or sends a
 * request body. Returns a "<METHOD> request to <host>" rendering, or null if the
 * command isn't a mutating HTTP request. Headlines the outward request ahead of
 * an incidental file redirect in a compound command.
 */
function summarizeMutatingCurl(command: string): Rendered | null {
  if (!/\b(?:curl|wget)\b/.test(command)) return null;
  // Read flags from the curl/wget step only: a `--json` or `-d` on another step
  // (`gh pr view --json state`, `unzip -d dir`) is not this request's body.
  // Quoted text of git, grep and echo is not a request (a commit message that
  // says "curl -d" is not a POST): look for curl in the blanked view.
  const steps = splitTopLevel(command);
  const step = steps.find((s) => /\b(?:curl|wget)\b/.test(blankTextCommandArgs(s)) && isMutatingCurlStep(s));
  if (!step) return null;
  const cmd = ` ${step}`;
  // `(?:^|\s)` not `\b`: `-X` is preceded by whitespace, and `\b` requires a
  // word char before the `-`, so `\b-X` never matches the usual ` -X DELETE`.
  const methodM = cmd.match(
    /(?:^|\s)-X\s*(DELETE|POST|PUT|PATCH)\b|(?:^|\s)--request[=\s]+(DELETE|POST|PUT|PATCH)\b/i,
  );
  const method = (methodM?.[1] || methodM?.[2] || "POST").toUpperCase();
  const url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0] || "";
  const host = url ? extractHost(url) : "URL";
  const kind: OperationKind =
    method === "DELETE" ? "http_delete" : method === "PUT" ? "http_put" : "http_post";
  // The endpoint path and the payload say what the request does; the raw
  // command's head is often just setup (`SP=/long/scratch/path; (curl …`) and
  // eats the whole preview before reaching either.
  const endpoint = url ? extractPath(url) : undefined;
  const payload = extractCurlPayload(cmd);
  return {
    title: `${method} request to ${host}`,
    target: endpoint,
    body: payload !== undefined
      ? truncateBody(payload)
      : command.length > COMMAND_INLINE_MAX ? truncateBody(command) : undefined,
    kind,
  };
}

function isMutatingCurlStep(step: string): boolean {
  const s = ` ${step}`;
  return /(?:^|\s)-X\s*(DELETE|POST|PUT|PATCH)\b|(?:^|\s)--request[=\s]+(DELETE|POST|PUT|PATCH)\b/i.test(s) ||
    /\s-d[\s=]|\s--data(?:-raw|-binary|-urlencode|-ascii)?[\s=]|\s-F[\s=]|\s--form[\s=]|\s(?:-T|--upload-file)[\s=]|\s--json[\s=]/.test(s);
}

/** Path (+ query) of a URL, or undefined for a bare origin. */
function extractPath(url: string): string | undefined {
  try {
    const u = new URL(url);
    const p = u.pathname + u.search;
    return p && p !== "/" ? truncate(p, 80) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The request body curl sends, from every body flag in order: `-d`/`--data*`
 * values joined with `&` (as curl joins them), `--json` values joined as-is,
 * and one line per `-F`/`--form` part. Only the first flag used to count, so
 * `-d charge=ch_1 -d amount=4900` lost the amount.
 */
function extractCurlPayload(cmd: string): string | undefined {
  const data: string[] = [];
  const json: string[] = [];
  const form: string[] = [];
  const re =
    /\s(-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form)(?:\s+|=)(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'"|;&]+))/g;
  for (const m of cmd.matchAll(re)) {
    const v = m[2] ?? m[3] ?? m[4];
    if (!v) continue;
    if (m[1] === "--json") json.push(v);
    else if (m[1] === "-F" || m[1] === "--form") form.push(v);
    else data.push(v);
  }
  const parts = [data.join("&"), json.join(""), form.join("\n")].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

function summarizeBash(command: string, sizeBytes?: number, cwd?: string): Rendered {
  let cmd = (command || "").trim();
  if (!cmd) return { title: "Run empty command", kind: "unknown_bash" };

  const compound = summarizeCompoundBash(cmd, sizeBytes, cwd);
  if (compound) return compound;

  // SQL detection runs before shell-write detection so that inline-interpreter
  // payloads (`node -e "..."`, `python -c "..."`) aren't misread as shell
  // redirects. JS arrow functions (`t => t.name`) and similar `=>` constructs
  // inside the quoted body otherwise match the `>` redirect regex.
  const sql = findSqlInCommand(cmd);
  if (sql) return summarizeSql(sql, cmd);

  // A Python or Node script fed by a heredoc is code: show it as a script, and
  // read the rest of the command without the script body, so its text
  // ("npm publish", "git push --force") does not name the card.
  const script = summarizeCodeHeredoc(cmd);
  if (script) return script;
  cmd = stripCodeHeredocBodies(cmd, { dropClose: true });

  // Text piped into a shell runs as a script that no step shows by name.
  const toShell = cmd.match(/^(.*?)\|\s*(?:sudo\s+)?((?:ba|z|k|da)?sh)\b(?!\s+-n\b)/s);
  if (toShell && !/\b(?:curl|wget)\b/.test(toShell[1]) && splitTopLevel(cmd, { pipes: false }).length === 1) {
    return { title: `Run text as a ${toShell[2]} script`, body: truncateBody(cmd), kind: "shell_pipeline" };
  }

  // A mutating curl/wget (POST/PUT/DELETE, or a request body) is described
  // BEFORE shell-write detection. In a compound command the outward request is
  // the headline operation, while a `> log` redirect is incidental — otherwise
  // `node … > /tmp/x.log … && curl -X POST …` mislabels as "Create file" even
  // though the prompt is driven by the POST.
  const mutatingCurl = summarizeMutatingCurl(cmd);
  if (mutatingCurl) return mutatingCurl;

  // npm publish is irreversible (a version can never be re-published), so it
  // headlines even inside a compound `cd pkg && npm run build && npm publish`.
  const npmPublish = summarizeNpmPublish(cmd, cwd);
  if (npmPublish) return npmPublish;

  const shellWrite = summarizeShellWrite(cmd);
  if (shellWrite) return shellWrite;

  // rm / trash — file deletion. Match the delete's OWN line (`[^\n]+`), not
  // `(.+)$`: without the `m` flag `$` only reaches end-of-string, so a `rm` on
  // an interior line of a multi-line script (e.g. `rm "$WT/node_modules"` before
  // a trailing `cd … && git status`) wouldn't match and the card fell back to
  // the generic "Run command". Match the shell text, so `rmdir` in a commit
  // message or a `--reason "…"` value is not a delete.
  const rmMatch = shellText(cmd).match(/\b(rm|trash|trash-put|rmdir)\s+(?:(-rf?|-fr|--recursive|-r)\s+)?([^\n]+)/);
  if (rmMatch && rmMatch[1] === "rmdir") {
    // rmdir removes empty folders only.
    const vars = literalAssignments(cmd);
    const targets = parseRmTargets(rmMatch[3]).map((t) => shortenPath(stripQuotes(expandVars(t, vars))));
    return targets.length <= 1
      ? { title: "Delete empty folder", target: targets[0], kind: "file_delete" }
      : { title: `Delete ${targets.length} empty folders`, target: targets.join("\n"), kind: "file_delete" };
  }
  if (rmMatch) {
    // Recursive only with an r/R flag: `rm -f x` deletes one file.
    const flags = (rmMatch[2] ? `${rmMatch[2]} ` : "") + rmMatch[3];
    const recursive = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/.test(flags.split(/[;&|\n]/)[0]);
    // `D=/some/dir; rm -f $D/x` shows the real path, not `$D/x`.
    const vars = literalAssignments(cmd);
    const targets = parseRmTargets(rmMatch[3]).map((t) => expandVars(t, vars));

    if (targets.length <= 1) {
      const target = targets[0] || "files";
      const sqlExt = !recursive && /\.sql$/i.test(target);
      return {
        title: recursive ? "Delete file recursively" : sqlExt ? "Delete SQL file" : "Delete file",
        target: shortenPath(stripQuotes(target)),
        annotation: sizeBytes !== undefined ? `(${formatByteCount(sizeBytes)})` : undefined,
        kind: "file_delete",
      };
    }

    return {
      title: recursive
        ? `Delete ${targets.length} files recursively`
        : `Delete ${targets.length} files`,
      target: targets.map(t => shortenPath(stripQuotes(t))).join("\n"),
      kind: "file_delete",
    };
  }

  // git. Each card names the repo: the folder the command runs in (after a
  // `cd` or `git -C`), shown as owner/name from its origin remote.
  const gitCmd = cmd.replace(GIT_C_RE, "git ");
  const repoAt = (re: RegExp) => gitRepoFor(cmd, re, cwd);
  const inRepo = (re: RegExp) => {
    const repo = repoAt(re);
    return repo ? ` in ${repo.name}` : "";
  };
  if (/\bgit\s+push\b/.test(shellText(gitCmd))) {
    // Parse the remote + branch ignoring flags (-u, --force, --set-upstream, …)
    // so `git push -u origin feat` renders "feat → origin", not "origin → -u".
    // The arguments end at a quote or a separator: `node x '["git push origin
    // main","git push …"]'` pushes main, not `main","git`.
    const after = gitCmd.match(/\bgit\s+push\b([^\n;&|"'`)]*)/)?.[1] ?? "";
    const args = after.split(/\s+/).filter((a) => a && !a.startsWith("-"));
    const repo = repoAt(/\bgit\s+(?:-C\s+\S+\s+)?push\b/);
    const remote = args[0] ?? (repo?.remotes.has("origin") ? "origin" : undefined);
    const branch = args[1] ?? (args[0] === undefined ? repo?.branch : undefined);
    const dest = remote ? repoSlug(repo?.remotes.get(remote)) ?? remote : undefined;
    // Name the local repo when the remote did not.
    const annotation = repo && dest !== repo.name && !(remote && repo.remotes.has(remote)) ? `in ${repo.name}` : undefined;
    const deleted = /\s(?:--delete|-d)\b/.test(after) ? args[1] : args[1]?.match(/^\+?:([^\s:]+)$/)?.[1];
    if (dest && deleted) {
      return { title: "Delete remote Git branch", target: `${deleted} on ${dest}`, annotation, kind: "git_branch_delete" };
    }
    const target = dest && branch ? `${branch} → ${dest}` : dest || "current branch";
    const forced = /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b/.test(gitCmd);
    return forced
      ? { title: "Force push", target, annotation, kind: "git_force_push" }
      : { title: "Push", target, annotation, kind: "git_push" };
  }
  const BRANCH_DELETE_RE = /\bgit\s+(?:-C\s+\S+\s+)?branch\s+(?:-D|--delete\s+--force|-d|--delete)\s+([^\s;&|]+)/;
  const branchDelete = cmd.match(BRANCH_DELETE_RE);
  if (branchDelete) {
    const forced = /\bgit\s+branch\s+(?:-D|--delete\s+--force)\b/.test(gitCmd);
    return {
      title: `Delete local Git branch${inRepo(BRANCH_DELETE_RE)}`,
      target: branchDelete[1],
      annotation: forced ? "even if not merged" : undefined,
      kind: "git_branch_delete",
    };
  }
  const prisma = summarizePrismaDeploy(cmd);
  if (prisma) return prisma;
  const GIT_RESET_RE = /\bgit\s+(?:-C\s+\S+\s+)?reset\s+--hard\b/;
  if (GIT_RESET_RE.test(cmd)) return { title: `Hard reset${inRepo(GIT_RESET_RE)}, discard all local changes`, kind: "git_reset_hard" };
  const GIT_CLEAN_RE = /\bgit\s+(?:-C\s+\S+\s+)?clean\s+-f/;
  if (GIT_CLEAN_RE.test(cmd)) return { title: `Remove all untracked files${inRepo(GIT_CLEAN_RE)}`, kind: "git_clean" };
  const GIT_CHECKOUT_RE = /\bgit\s+(?:-C\s+\S+\s+)?checkout\s+--\s+\./;
  if (GIT_CHECKOUT_RE.test(cmd)) return { title: `Discard all unstaged changes${inRepo(GIT_CHECKOUT_RE)}`, kind: "git_checkout" };
  const GIT_RESTORE_RE = /\bgit\s+(?:-C\s+\S+\s+)?restore\s+--staged\s+\./;
  if (GIT_RESTORE_RE.test(cmd)) return { title: `Unstage all staged changes${inRepo(GIT_RESTORE_RE)}`, kind: "git_restore" };
  const GIT_COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
  if (GIT_COMMIT_RE.test(cmd)) {
    // Pull a simple quoted -m message. Bail (show plain "Git commit") when the
    // message is a command substitution / heredoc — `-m "$(cat <<'EOF' … )"` —
    // since that has no clean inline title to extract.
    const m = cmd.match(/-m\s+["']([^"'$]+)["']/);
    // The subject line only: a multi-line message made a multi-line title.
    const where = inRepo(GIT_COMMIT_RE);
    return m
      ? { title: `Git commit "${truncate(m[1].split("\n")[0].trim(), 60)}"${where}`, kind: "git_commit" }
      : { title: `Git commit${where}`, kind: "git_commit" };
  }

  const gh = summarizeGh(cmd);
  if (gh) return gh;

  // gh pr create — reversible (PRs can be closed). Extract --title when present.
  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const m = cmd.match(/--title\s+["']([^"']+)["']/);
    return m
      ? { title: `Create PR "${truncate(m[1], 60)}"`, kind: "git_pr_create" }
      : { title: "Create pull request", kind: "git_pr_create" };
  }

  // ssh to a remote host — remote side effects can't be undone from here.
  // Skip ssh subcommands that aren't remote-exec (`ssh-keygen`, `ssh-add`,
  // `ssh-keyscan`) by requiring a `user@host` token. Pull the remote command
  // (anything after the host) so the approval card shows what will run there.
  if (/^ssh\b/.test(cmd)) {
    const hostM = cmd.match(/(\S+@\S+)(?:\s+(.+))?$/);
    if (hostM) {
      const target = hostM[1];
      const remoteCmd = hostM[2]?.trim();
      return {
        title: `SSH to ${target}`,
        target,
        body: remoteCmd ? truncateBody(remoteCmd) : undefined,
        kind: "ssh_remote",
      };
    }
  }

  if (/\bwget\b.*\|\s*(bash|sh|zsh)\b/.test(cmd) || /\bcurl\b.*\|\s*(bash|sh|zsh)\b/.test(cmd)) {
    const url = cmd.match(/https?:\/\/[^\s|'"]+/)?.[0];
    return {
      title: `Download and execute script${url ? ` from ${extractHost(url)}` : ""}`,
      body: truncateBody(cmd),
      kind: "http_pipe_to_shell",
    };
  }

  // himalaya — email CLI (run BEFORE the pipeline catch-all so
  // `printf ... | himalaya message send` renders as "Send email", not
  // "Run command"). Parses From/To/Subject from the piped headers so
  // the approval card shows recipient + subject, not a raw shell line.
  if (/\bhimalaya\b/.test(cmd)) {
    const h = summarizeHimalaya(cmd);
    if (h) return h;
  }

  // Process kill in COMMAND POSITION — headline it ahead of the compound
  // "Run command" catch-all below, so a cleanup script like
  // `if pgrep …; then pkill -f …; fi` reads "Kill processes", not "Run command".
  // Command-position only (stage start, after ;/&&/||/newline/$( / a keyword),
  // so "kill" inside echo text (e.g. "killing it") doesn't mislabel.
  const killM = cmd.match(
    /(?:^|[\n;&|`({]|\$\(|\b(?:sudo|then|do|else|command|xargs)\s+)\s*(killall|pkill|kill)\b/,
  );
  if (killM) {
    return { ...killTarget(cmd.slice((killM.index ?? 0) + killM[0].length - killM[1].length)), body: truncateBody(cmd), kind: "kill_process" };
  }

  // Multi-step pipeline
  if (/&&|\|\||;/.test(cmd)) return { title: "Run command", body: truncateBody(cmd), kind: "shell_pipeline" };

  // docker
  if (/\bdocker\s+compose\s+down\b/.test(cmd)) return { title: "Stop and remove Docker containers", kind: "docker_down" };
  if (/\bdocker\s+compose\s+up\b/.test(cmd)) return { title: "Start Docker containers", kind: "docker_up" };
  if (/\bdocker\s+system\s+prune\b/.test(cmd)) return { title: "Prune unused Docker resources", kind: "docker_prune" };
  const dockerRmi = cmd.match(/\bdocker\s+rmi\s+(\S+)/);
  if (dockerRmi) return { title: "Remove Docker image", target: dockerRmi[1], kind: "docker_rmi" };
  const dockerRm = cmd.match(/\bdocker\s+rm\s+(\S+)/);
  if (dockerRm) return { title: "Remove Docker container", target: dockerRm[1], kind: "docker_rm" };

  // Railway: deploys and tear-downs of a live service.
  const railway = cmd.match(/\brailway\s+(up|deploy|redeploy|down|delete)\b(.*)$/s);
  if (railway) {
    const service = railway[2].match(/\s(?:-s|--service)[\s=]+(\S+)/)?.[1];
    const env = railway[2].match(/\s(?:-e|--environment)[\s=]+(\S+)/)?.[1];
    const verb = railway[1] === "down" ? "Remove the latest Railway deployment"
      : railway[1] === "delete" ? "Delete the Railway project"
      : railway[1] === "redeploy" ? "Redeploy on Railway" : "Deploy to Railway";
    return { title: verb, target: service, annotation: env ? `(${env})` : undefined, kind: "deploy" };
  }

  // npm / npx
  const npmScript = cmd.match(/\bnpm\s+run\s+(\S+)/);
  if (npmScript) return { title: `Run npm script ${npmScript[1]}`, kind: "npm_run" };
  if (/\bnpm\s+install\b/.test(cmd)) return { title: "Install npm dependencies", kind: "npm_install" };
  if (/\bnpm\s+test\b/.test(cmd)) return { title: "Run npm tests", kind: "npm_test" };
  if (/\bnpm\s+unpublish\b/.test(shellText(cmd))) return { title: "Unpublish package from npm", kind: "npm_unpublish" };
  if (/\bnpx\s+.*\s+deploy\b/.test(shellText(cmd))) return { title: "Deploy via npx", body: truncateBody(cmd), kind: "npx_deploy" };

  // sudo / chmod (kill/pkill/killall are handled in command position above,
  // ahead of the compound catch-all).
  if (/\bsudo\b/.test(cmd)) {
    const inner = cmd.replace(/^sudo\s+/, "");
    return { title: `Run as root: ${truncate(inner, COMMAND_INLINE_MAX)}`, body: truncateBody(cmd), kind: "sudo" };
  }
  if (/\bchmod\s+777\b/.test(cmd)) {
    const target = cmd.match(/chmod\s+777\s+(\S+)/)?.[1] || "file";
    return { title: `Make ${target} world-writable (chmod 777)`, kind: "chmod_777" };
  }

  // Long or short — generic command
  if (cmd.length > COMMAND_INLINE_MAX) return { title: "Run command", body: truncateBody(cmd), kind: "unknown_bash" };
  return { title: cmd, kind: "unknown_bash" };
}

/**
 * A command of several steps (`;`, `&&`, `||`, newlines) takes its title from
 * the step that set the tier, so `gh pr merge … ; gh pr view --json … ; curl
 * -X POST …` reads "POST request to api.oked.ai", not a title built from bits
 * of three steps. Other steps that need approval on their own are listed in the
 * subline. Returns null when no step needs approval, or when the tier comes
 * from a pattern that spans steps (`curl … | sh`): the whole-command rules
 * below describe those.
 */
function summarizeCompoundBash(cmd: string, sizeBytes?: number, cwd?: string): Rendered | null {
  const steps = splitTopLevel(cmd, { pipes: false });
  if (steps.length < 2) return null;
  const tiers = steps.map((s) => classify("Bash", { command: s }));
  const rank = tiers.map((t) => TIER_ORDER[t]);
  const top = Math.max(...rank);
  if (top < TIER_ORDER.review) return null;
  if (TIER_ORDER[classify("Bash", { command: cmd })] !== top) return null;
  const lead = rank.indexOf(top);
  // Variables set by earlier steps (`D=/dir; rm $D/x`) show as their values.
  const vars = literalAssignments(cmd);
  const step = expandVars(steps[lead], vars);
  // npm publish reads the package.json a preceding `cd` points at; prisma reads
  // a DATABASE_URL an earlier step exported.
  // A step runs in the folder that the `cd` steps before it moved to.
  const dirAt = (i: number) => cwdAfterCds(steps.slice(0, i), vars, cwd);
  const r = (/\bnpm\s+publish\b/.test(step) && summarizeNpmPublish(cmd, cwd)) ||
    summarizePrismaDeploy(/\bprisma\s+migrate\s+deploy\b/.test(step) ? cmd : "") ||
    summarizeBash(step, sizeBytes, dirAt(lead));
  const also = [...new Set(
    steps
      .map((s, i) => (i !== lead && rank[i] >= TIER_ORDER.review ? describeStep(expandVars(s, vars), dirAt(i)) : ""))
      .filter(Boolean),
  )].filter((t) => t !== describeStep(step, dirAt(lead)));
  // The body shows the steps that need approval, not the setup and polling
  // around them.
  const risky = steps.filter((_, i) => rank[i] >= TIER_ORDER.review);
  return {
    ...r,
    subline: also.length ? `Also: ${also.join("; ")}` : r.subline,
    body: r.body ?? truncateBody(risky.join("\n")),
  };
}

function describeStep(step: string, cwd?: string): string {
  const r = summarizeBash(step, undefined, cwd);
  return r.target && !r.title.includes(r.target) ? `${r.title} ${r.target}` : r.title;
}

/** GitHub CLI writes: which PR, issue or release, in which repo. */
function summarizeGh(cmd: string): Rendered | null {
  const m = cmd.match(/\bgh\s+(pr|issue|release|repo|workflow|run|secret|variable|api)\s+(\S+)(.*)$/s);
  if (!m) return null;
  const [, noun, verb, rest] = m;
  const url = rest.match(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/);
  const repoFlag = rest.match(/\s(?:-R|--repo)[\s=]+(\S+)/)?.[1];
  const repo = url?.[1] ?? repoFlag;
  const num = url?.[2] ?? rest.match(/^\s+#?(\d+)\b/)?.[1];
  const ref = num ? `#${num}` : "";
  const where = repo ? ` in ${repo}` : "";
  if (noun === "pr" && verb === "merge") {
    const how = /\s(?:--squash|-s)\b/.test(rest) ? "squash" : /\s(?:--rebase|-r)\b/.test(rest) ? "rebase" : undefined;
    const auto = /\s--auto\b/.test(rest);
    return {
      title: `Merge PR ${ref}${where}`.replace(/\s+/g, " ").trim(),
      annotation: [how, auto ? "when checks pass" : undefined, /\s(?:--delete-branch|-d)\b/.test(rest) ? "deletes branch" : undefined]
        .filter(Boolean).join(", ") || undefined,
      kind: "git_pr_merge",
    };
  }
  if (noun === "api") {
    const args = ` ${verb}${rest}`;
    const method = args.match(/\s(?:-X|--method)(?:\s+|=)?([A-Za-z]+)\b/)?.[1]?.toUpperCase();
    // The endpoint is the first argument that is not a flag or a flag's value.
    const endpoint = args
      .replace(/\s(?:-X|--method|-H|--header|-f|-F|--field|--raw-field|--input|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)(?:\s+|=)(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S+)/g, " ")
      .split(/\s+/).find((w) => w && !w.startsWith("-"))?.replace(/^['"]|['"]$/g, "");
    if (endpoint === "graphql") {
      const mutation = /\bmutation\b/.test(args);
      return { title: mutation ? "Change data via GitHub GraphQL API" : "Query GitHub GraphQL API", body: truncateBody(cmd), kind: mutation ? "http_post" : "http_get" };
    }
    const m2 = method ?? (/\s(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/.test(args) ? "POST" : "GET");
    return {
      title: `${m2} request to GitHub API`,
      target: endpoint,
      body: truncateBody(cmd),
      kind: m2 === "DELETE" ? "http_delete" : m2 === "PUT" ? "http_put" : m2 === "GET" ? "http_get" : "http_post",
    };
  }
  const outward = new Set(["merge", "close", "reopen", "comment", "review", "edit", "ready", "delete", "archive", "rename",
    "create", "upload", "set", "run", "cancel", "rerun", "transfer", "fork", "enable", "disable"]);
  if (!outward.has(verb) || (noun === "pr" && verb === "create")) return null;
  const thing = { pr: "PR", issue: "issue", release: "release", repo: "repo", workflow: "workflow", run: "workflow run", secret: "secret", variable: "variable" }[noun] ?? noun;
  const name = noun === "release" || noun === "secret" || noun === "variable" || noun === "workflow"
    ? rest.match(/^\s+([^\s-][^\s]*)/)?.[1] : undefined;
  const body = rest.match(/\s(?:-b|--body)[\s=]+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/);
  const obj = `${thing}${ref ? ` ${ref}` : name ? ` ${name}` : ""}`;
  const phrase = verb === "comment" ? `Comment on ${obj}`
    : verb === "ready" ? `Mark ${obj} ready for review`
    : verb === "set" ? `Set ${obj}`
    : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${obj}`;
  return {
    title: `${phrase}${where}`,
    body: body ? truncateBody(body[1] ?? body[2] ?? "") : undefined,
    kind: noun === "pr" ? "git_pr_write" : "gh_write",
  };
}

/**
 * `npm publish` → which package and version, dist-tag, access, registry.
 * Name/version come from the package.json the publish will read: the cwd,
 * adjusted by a preceding `cd`, a `--workspace`, or a folder argument.
 */
const NPM_PUBLISH_STEP_RE = /(?:^|[\n;&|(]|\$\()\s*(?:\w+=\S+\s+)*(?:sudo\s+)?npm\s+publish\b([^\n;&|)]*)/;

function summarizeNpmPublish(cmd: string, cwd?: string): Rendered | null {
  const m = cmd.match(NPM_PUBLISH_STEP_RE);
  // `grep "verify\|npm publish" x | head` searches for the words, it does not publish.
  if (!m || !NPM_PUBLISH_STEP_RE.test(shellText(cmd))) return null;

  const tokens = m[1].trim().split(/\s+/).filter(Boolean).map(stripQuotes);
  const flags: Record<string, string | true> = {};
  const workspaces: string[] = [];
  let positional: string | undefined;
  const VALUE_FLAGS = new Set(["--tag", "--access", "--registry", "--otp", "--workspace", "-w"]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      const name = eq > 0 ? t.slice(0, eq) : t;
      let value: string | true = eq > 0 ? t.slice(eq + 1) : true;
      if (value === true && VALUE_FLAGS.has(name) && i + 1 < tokens.length) value = tokens[++i];
      if ((name === "--workspace" || name === "-w") && typeof value === "string") workspaces.push(value);
      else flags[name] = value;
    } else if (positional === undefined && /^[\w.~/@-][\w.~/@+-]*$/.test(t)) {
      // A folder or tarball. Quote and bracket leftovers from quoted data
      // (`…publish\"]'`) are not a path.
      positional = t;
    }
  }

  // Directory the publish runs in: cwd, then the last `cd X` before it.
  let baseDir = cwd;
  const before = cmd.slice(0, m.index ?? 0);
  const cds = [...before.matchAll(/(?:^|[\n;&|(])\s*cd\s+("[^"]+"|'[^']+'|\S+)/g)];
  if (cds.length) {
    const dir = stripQuotes(cds[cds.length - 1][1]);
    // `cd $SP/pkg`: the variable is not known here, so the folder is not known.
    baseDir = /[$`]/.test(dir) ? undefined : isAbsolute(dir) ? dir : baseDir ? resolve(baseDir, dir) : undefined;
  }

  const allWorkspaces = flags["--workspaces"] === true || flags["-ws"] === true;
  let pkgDirs: string[] = [];
  let tarball: string | undefined;
  if (positional && /\.(tgz|tar\.gz)$/.test(positional)) tarball = positional;
  else if (allWorkspaces) pkgDirs = baseDir ? listWorkspaceDirs(baseDir) : [];
  else if (workspaces.length) pkgDirs = workspaces.map((w) => (baseDir ? resolve(baseDir, w) : w));
  else if (positional) pkgDirs = [baseDir ? resolve(baseDir, positional) : positional];
  else if (baseDir) pkgDirs = [baseDir];

  const labels = pkgDirs.map((d) => readPackageLabel(d) ?? shortenPath(d));
  const isPrivate = pkgDirs.some((d) => readPackageJson(d)?.private === true);

  let target: string | undefined;
  if (tarball) target = basename(tarball);
  else if (labels.length) target = labels.join("\n");
  else if (allWorkspaces) target = "all workspaces";
  else if (workspaces.length) target = workspaces.join("\n");

  const details: string[] = [];
  details.push(`tag ${typeof flags["--tag"] === "string" ? flags["--tag"] : "latest"}`);
  if (typeof flags["--access"] === "string") details.push(`${flags["--access"]} access`);
  if (typeof flags["--registry"] === "string") details.push(`registry ${extractHost(flags["--registry"])}`);
  if (flags["--provenance"] === true) details.push("with provenance");

  const dryRun = flags["--dry-run"] === true;
  const count = tarball ? 1 : Math.max(labels.length, 1);
  const title = count > 1 ? `Publish ${count} packages to npm` : "Publish package to npm";
  // Never echo a one-time password onto the approval card.
  const shown = cmd.replace(/(--otp(?:=|\s+))\S+/g, "$1***");
  return {
    title: dryRun ? `${title} (dry run)` : title,
    target,
    subline: details.join(" · "),
    body: shown.trim() === "npm publish" ? undefined : truncateBody(shown),
    footnote: isPrivate ? "package.json is marked private, npm will refuse to publish it" : undefined,
    kind: "npm_publish",
  };
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function readPackageLabel(dir: string): string | null {
  const pkg = readPackageJson(dir);
  if (!pkg || typeof pkg.name !== "string") return null;
  return typeof pkg.version === "string" ? `${pkg.name}@${pkg.version}` : pkg.name;
}

/** Expand the root package.json `workspaces` (plain dirs and `dir/*` globs). */
function listWorkspaceDirs(root: string): string[] {
  const pkg = readPackageJson(root);
  const ws = Array.isArray(pkg?.workspaces)
    ? pkg!.workspaces
    : (pkg?.workspaces as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(ws)) return [];
  const dirs: string[] = [];
  for (const pattern of ws) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) {
      const parent = resolve(root, pattern.slice(0, -2));
      try {
        for (const e of readdirSync(parent, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(parent, e.name, "package.json"))) dirs.push(join(parent, e.name));
        }
      } catch { /* missing dir */ }
    } else if (!pattern.includes("*")) {
      dirs.push(resolve(root, pattern));
    }
  }
  // npm skips private workspaces under --workspaces.
  return dirs.filter((d) => readPackageJson(d)?.private !== true);
}

function summarizeShellWrite(cmd: string): Rendered | null {
  const ops = extractShellWriteOps(cmd);
  if (!ops.length) return null;
  const op = ops.find((o) => o.kind !== "copy" && o.kind !== "move") || ops[0];
  const path = shortenPath(op.target);

  switch (op.kind) {
    case "create":
      return { title: "Create file", target: path, body: op.content ?? cmd, kind: "file_create" };
    case "append":
      return { title: "Append to file", target: path, body: op.content ?? cmd, kind: "file_append" };
    case "edit":
      return { title: "Edit file", target: path, body: cmd, kind: "file_edit" };
    case "touch":
      return { title: "Create empty file", target: path, kind: "file_touch" };
    case "copy":
      return {
        title: "Copy file",
        target: op.source ? `${shortenPath(op.source)} → ${path}` : path,
        kind: "file_copy",
      };
    case "move":
      return {
        title: "Move file",
        target: op.source ? `${shortenPath(op.source)} → ${path}` : path,
        kind: "file_move",
      };
  }
}

export const SQL_KEYWORDS_RE = /\b(DROP\s+(TABLE|DATABASE|INDEX|VIEW)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+(?:OR\s+\w+\s+)?INTO|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE)\b/i;

// Extract SQL statements from Python/Ruby/JS script bodies — pulls out the
// string arguments to .execute(), .query(), .run() etc. rather than
// returning the whole script as the "sql" body.
function extractSqlFromScriptBody(body: string): string | null {
  const sqls: string[] = [];
  const re = /\.(?:execute|executemany|query|run|exec)\s*\(\s*(?:["'`])([\s\S]+?)(?:["'`])\s*[,)]/gi;
  for (const m of body.matchAll(re)) {
    const sql = m[1].trim().replace(/\s+/g, " ");
    if (SQL_KEYWORDS_RE.test(sql)) sqls.push(sql);
  }
  return sqls.length > 0 ? sqls.join("\n") : null;
}

// A SQL CLI or code interpreter as a command word — at the start of the command
// (allowing env=val / sudo prefixes) or after a pipe / `&&` / `;` / `$(`. Used
// to gate SQL extraction so SQL words appearing in *argument data* (a `gh pr
// create --body` mentioning "TRUNCATE", a path like `better-sqlite3`) don't get
// misread as a statement to run.
const SQL_CLI_CONSUMER_RE =
  /(?:^|\||&&|;|\$\(|`)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|mariadb|sqlite3?)\b/;
const INTERPRETER_CONSUMER_RE =
  /(?:^|\||&&|;|\$\(|`)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:node|python\d?|ruby|perl|deno|bun)\b/;

// A database client library named in a script body. A script that has SQL
// words but no .execute()-style call and no DB library cannot run SQL: it is
// text processing (a Python script that edits a source file whose comments
// say "DELETE FROM", for example), so it must not be shown as a SQL statement.
//
// The library must be loaded (import, require, from, use), not only named: a
// script that edits describe.ts, whose text says "psql" and "sqlite3", or a
// schema.prisma file, names a library without using one.
const DB_LIBRARY_RE =
  /(?:\bimport\s+|\bfrom\s+)['"]?(?:sqlite3|better-sqlite3|psycopg2?|psycopg|pymysql|MySQLdb|mysql2?|sqlalchemy|duckdb|knex|pg|@prisma\/client)\b|\brequire\(\s*['"](?:sqlite3|better-sqlite3|pg|mysql2?|knex|duckdb|@prisma\/client)['"]|\bnew\s+PrismaClient\b|\buse\s+DBI\b|\bSequel\.connect\b|\bsqlite3\.connect\s*\(|\bpsycopg2?\.connect\s*\(/;

// SQL to run from an interpreter body (node -e, python -c, `python - <<EOF`).
function sqlFromInterpreterBody(body: string): string | null {
  if (!SQL_KEYWORDS_RE.test(body)) return null;
  const extracted = extractSqlFromScriptBody(body);
  if (extracted) return extracted;
  return DB_LIBRARY_RE.test(body) ? body : null;
}

/**
 * Shell words of `s` up to the first unquoted operator (| ; & < > or a
 * newline), with quotes removed and `\"`-style escapes resolved. `quoted` marks
 * a word that had a quoted part. Undefined when a quote is never closed.
 */
function shellWords(s: string): { text: string; quoted: boolean }[] | undefined {
  const words: { text: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
    if (i >= s.length || /[|;&<>\n]/.test(s[i])) break;
    let text = "";
    let quoted = false;
    while (i < s.length && !/[\s|;&<>]/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) return undefined;
        text += s.slice(i + 1, end);
        i = end + 1;
        quoted = true;
      } else if (c === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\" && /["\\$`]/.test(s[j + 1] ?? "")) {
            text += s[j + 1];
            j += 2;
          } else {
            text += s[j++];
          }
        }
        if (j >= s.length) return undefined;
        i = j + 1;
        quoted = true;
      } else if (c === "\\" && i + 1 < s.length) {
        text += s[i + 1];
        i += 2;
      } else {
        text += c;
        i++;
      }
    }
    words.push({ text, quoted });
  }
  return words;
}

// The flag that carries a statement, per SQL CLI. psql's `-e` is --echo-queries
// and takes no value, so it must not count there.
const SQL_CLI_STATEMENT_FLAGS: Record<string, { short?: string; long: string }> = {
  psql: { short: "-c", long: "--command" },
  mysql: { short: "-e", long: "--execute" },
  mariadb: { short: "-e", long: "--execute" },
  sqlite3: { long: "-cmd" },
  sqlite: { long: "-cmd" },
};

/**
 * The SQL a psql / mysql / sqlite3 invocation runs, from its arguments.
 * Every statement flag counts (`psql -c "SELECT 1" -c "DROP TABLE t"` runs
 * both), so a harmless first statement can't hide a destructive one. With no
 * flag, quoted positional arguments that read as SQL (`sqlite3 db "…"`), else
 * a trailing quoted argument as before. Undefined when the arguments can't be
 * read (unbalanced quotes), so the caller can fall back.
 */
function sqlFromCliArgs(tool: string, args: string): string | null | undefined {
  const words = shellWords(args);
  if (!words) return undefined;
  const flags = SQL_CLI_STATEMENT_FLAGS[tool];
  const statements: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k].text;
    if (w === flags.long || (flags.short && w === flags.short)) {
      if (k + 1 < words.length) statements.push(words[++k].text);
    } else if (w.startsWith(flags.long + "=")) {
      statements.push(w.slice(flags.long.length + 1));
    } else if (flags.short && words[k].quoted && w.length > 2 && w.startsWith(flags.short)) {
      statements.push(w.slice(2)); // -c"SELECT …"
    }
  }
  if (statements.length) return statements.join("\n");

  const quoted = words.filter(w => w.quoted).map(w => w.text);
  const sqlish = quoted.filter(q => SQL_KEYWORDS_RE.test(q));
  if (sqlish.length) return sqlish.join("\n");
  const last = words[words.length - 1];
  return last?.quoted && words.length > 1 && /["']\s*$/.test(args) ? last.text : null;
}

export function findSqlInCommand(cmd: string): string | null {
  // Inline interpreter flags: node -e, python -c, ruby -e, perl -e. Anchored to
  // a command position so a SQL-looking string elsewhere doesn't match.
  const inline = cmd.match(/(?:^|\||&&|;|\$\()\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:node|python\d?|ruby|perl|deno|bun)\s+-[ec]\s+(?:"([\s\S]+?)"|'([\s\S]+?)')\s*$/);
  if (inline) {
    const body = inline[1] ?? inline[2];
    const sql = body ? sqlFromInterpreterBody(body) : null;
    if (sql) return sql;
  }

  // psql -c "..." / mysql -e "..." / sqlite3 db "..." — read the arguments as
  // shell words, so a quoted connection string before the statement
  // (`psql "$DATABASE_URL" -c "DELETE …"`) isn't swallowed into it. Anchored to
  // the start of the command so "psql"/"mysql" appearing inside an argument
  // (another tool's --body, etc.) can't trigger a false SQL match.
  const cli = cmd.match(/^(?:\s*\w+=\S+\s+)*(?:sudo\s+)?(psql|mysql|sqlite3?|mariadb)\b/i);
  const fromArgs = cli ? sqlFromCliArgs(cli[1].toLowerCase(), cmd.slice(cli[0].length)) : null;
  if (fromArgs) return fromArgs;
  if (fromArgs === undefined) {
    // Unbalanced quotes: fall back to the outer-quoted span.
    const dq = cmd.match(/^(?:\s*\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|sqlite3?|mariadb)\b[^"]*"([\s\S]+?)"\s*$/i);
    if (dq) return dq[1];
    const sq = cmd.match(/^(?:\s*\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|sqlite3?|mariadb)\b[^']*'([\s\S]+?)'\s*$/i);
    if (sq) return sq[1];
  }
  // No statement in the arguments: a heredoc may still feed one (below).

  // Heredoc-piped script: <<EOF / <<'EOF' / <<"EOF" / <<-EOF. Only when the
  // command (outside the body) actually feeds the heredoc to a SQL CLI or
  // interpreter — otherwise a `gh`/`cat`/`mail` heredoc whose body merely
  // mentions SQL words would be misclassified as a statement to run.
  const hd = cmd.match(/<<-?\s*['"]?(\w+)['"]?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1\b/);
  if (hd) {
    const body = hd[2];
    const context = cmd.slice(0, hd.index) + cmd.slice((hd.index ?? 0) + hd[0].length);
    if (body && SQL_CLI_CONSUMER_RE.test(context) && SQL_KEYWORDS_RE.test(body)) {
      return extractSqlFromScriptBody(body) ?? body;
    }
    if (body && INTERPRETER_CONSUMER_RE.test(context)) {
      const sql = sqlFromInterpreterBody(body);
      if (sql) return sql;
    }
  }

  // Direct SQL keywords at top of command
  if (/^\s*(DROP|DELETE\s+FROM|TRUNCATE|UPDATE|INSERT\s+INTO|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(cmd)) {
    return cmd;
  }
  return null;
}

function summarizeSql(sql: string, originalCommand: string): Rendered {
  const trimmed = sql.replace(/\s+/g, " ").trim();

  // DROP — collect all targets for compound statements
  const dropMatches = [...trimmed.matchAll(/\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)["`]?/gi)];
  if (dropMatches.length === 1) {
    return {
      title: `Drop ${dropMatches[0][1].toLowerCase()}`,
      target: dropMatches[0][2],
      body: sql.length > COMMAND_INLINE_MAX ? truncateBody(sql) : undefined,
      kind: "sql_drop",
    };
  }
  if (dropMatches.length > 1) {
    const names = dropMatches.map(m => m[2]);
    const types = new Set(dropMatches.map(m => m[1].toLowerCase()));
    const typeLabel = types.size === 1 ? `${[...types][0]}s` : "objects";
    return {
      title: `Drop ${dropMatches.length} ${typeLabel}`,
      target: names.join("\n"),
      kind: "sql_drop",
    };
  }

  // TRUNCATE — collect all targets
  const truncMatches = [...trimmed.matchAll(/\bTRUNCATE\s+(?:TABLE\s+)?["`]?([\w.]+)["`]?/gi)];
  if (truncMatches.length === 1) {
    return { title: "Truncate table", target: truncMatches[0][1], annotation: "(delete all rows)", body: truncateBody(sql), kind: "sql_truncate" };
  }
  if (truncMatches.length > 1) {
    return {
      title: `Truncate ${truncMatches.length} tables`,
      target: truncMatches.map(m => m[1]).join("\n"),
      annotation: "(delete all rows)",
      kind: "sql_truncate",
    };
  }

  const alterM = trimmed.match(/\bALTER\s+TABLE\s+["`]?([\w.]+)["`]?/i);
  if (alterM) {
    return { title: "Alter table", target: alterM[1], body: truncateBody(sql), kind: "sql_alter" };
  }
  const createM = trimmed.match(/\bCREATE\s+(TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?/i);
  if (createM) {
    return { title: `Create SQL ${createM[1].toLowerCase()}`, target: createM[2], body: truncateBody(sql), kind: "sql_create" };
  }

  // DELETE FROM — collect all targets
  const deleteMatches = [...trimmed.matchAll(/\bDELETE\s+FROM\s+["`]?([\w.]+)["`]?/gi)];
  if (deleteMatches.length === 1) {
    const thisStmt = stmtSlice(trimmed, deleteMatches[0].index ?? 0);
    const hasWhere = /\bWHERE\b/i.test(thisStmt);
    return {
      title: hasWhere ? "Delete rows from" : "Delete ALL rows from",
      target: deleteMatches[0][1],
      body: truncateBody(sql),
      kind: hasWhere ? "sql_delete_rows" : "sql_delete_all_rows",
    };
  }
  if (deleteMatches.length > 1) {
    const anyWithoutWhere = deleteMatches.some(m => {
      const stmt = stmtSlice(trimmed, m.index ?? 0);
      return !/\bWHERE\b/i.test(stmt);
    });
    return {
      title: anyWithoutWhere
        ? `Delete ALL rows from ${deleteMatches.length} tables`
        : `Delete rows from ${deleteMatches.length} tables`,
      target: deleteMatches.map(m => m[1]).join("\n"),
      body: truncateBody(sql),
      kind: anyWithoutWhere ? "sql_delete_all_rows" : "sql_delete_rows",
    };
  }
  const updateM = trimmed.match(/\bUPDATE\s+["`]?([\w.]+)["`]?\s+SET/i);
  if (updateM) {
    const thisStmt = stmtSlice(trimmed, updateM.index ?? 0);
    const hasWhere = /\bWHERE\b/i.test(thisStmt);
    return {
      title: hasWhere ? "Update rows in" : "Update EVERY row in",
      target: updateM[1],
      body: truncateBody(sql),
      kind: hasWhere ? "sql_update_rows" : "sql_update_every_row",
    };
  }
  const insertM = trimmed.match(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?([\w.]+)["`]?/i);
  if (insertM) {
    return { title: "Insert rows into", target: insertM[1], body: truncateBody(sql), kind: "sql_insert" };
  }
  return { title: "Run SQL statement", body: truncateBody(sql || originalCommand), kind: "sql_query" };
}

// ───────────────────────────────────────────────────────────────────────
// himalaya — email CLI
// ───────────────────────────────────────────────────────────────────────

/**
 * Render a himalaya invocation as a proper email-domain action ("Send email
 * to X", "Delete email N", "Purge folder Y") instead of a raw shell line.
 *
 * Used for both the approval-card display (so the user sees "Send email to
 * contact@oked.ai" with the subject + sender, not a printf|himalaya
 * pipeline) and the analytics `operation_kind`.
 *
 * Returns null if the command mentions himalaya but doesn't match a known
 * subcommand pattern — caller falls back to the generic pipeline/unknown
 * renderers.
 */
function summarizeHimalaya(cmd: string): Rendered | null {
  // message send — the only path that prompts approval today. Parse the
  // headers from the piped payload so the user sees recipient + subject.
  if (/\bhimalaya\s+(?:\S+\s+)*message\s+send\b/.test(cmd)) {
    const headers = extractEmailHeaders(cmd);
    const to = headers.to;
    const subject = headers.subject;
    const from = headers.from;

    const bodyLines: string[] = [];
    if (from) bodyLines.push(`From: ${from}`);
    if (subject) bodyLines.push(`Subject: ${subject}`);
    const previewBody = headers.body ? truncate(headers.body, 200) : undefined;
    if (previewBody) bodyLines.push("", previewBody);

    return {
      title: to ? `Send email to ${to}` : "Send email",
      target: to,
      body: bodyLines.length > 0 ? bodyLines.join("\n") : truncateBody(cmd),
      kind: "email_send",
    };
  }

  // message delete <id...> — irreversible (Gmail moves to trash; other
  // servers may hard-delete).
  const delM = cmd.match(/\bhimalaya\s+(?:\S+\s+)*message\s+delete\s+([\d\s,]+)/);
  if (delM) {
    const ids = delM[1].trim();
    const count = ids.split(/[\s,]+/).filter(Boolean).length;
    return {
      title: count > 1 ? `Delete ${count} emails` : "Delete email",
      target: ids,
      annotation: "(irreversible)",
      kind: "email_delete",
    };
  }

  // folder delete / expunge / purge — wipes a mail folder.
  const folderM = cmd.match(/\bhimalaya\s+(?:\S+\s+)*folder\s+(delete|expunge|purge)\s+(\S+)/);
  if (folderM) {
    const verb = folderM[1].toLowerCase();
    const folder = stripQuotes(folderM[2]);
    const verbLabel = verb === "purge" ? "Purge" : verb === "expunge" ? "Expunge" : "Delete";
    return {
      title: `${verbLabel} folder ${folder}`,
      target: folder,
      annotation: "(irreversible)",
      kind: "email_purge",
    };
  }

  return null;
}

/**
 * Extract email headers (From/To/Subject) and body from a shell command
 * that pipes a printf/echo/heredoc into `himalaya message send`. Returns
 * empty strings for anything not found.
 *
 * Handles the two common shapes the agent emits:
 *   printf "From: a\nTo: b\nSubject: c\n\nbody" | himalaya message send
 *   printf %s "From: a\nTo: b\n..." | himalaya message send
 *   cat <<'EOF' | himalaya message send  (heredoc body, headers inline)
 */
function extractEmailHeaders(cmd: string): {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
} {
  // Pull the quoted payload from printf/echo if present.
  const quoted = cmd.match(/(?:printf|echo)\s+(?:%s\s+|-[neE]+\s+)*(['"])([\s\S]*?)\1/);
  // Also support heredoc body (cat <<EOF ... EOF).
  const heredoc = cmd.match(/<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\b/);

  let payload = quoted?.[2] ?? heredoc?.[2] ?? cmd;
  // Unescape \n / \r / \t to real characters so header regexes work.
  payload = payload.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");

  const grab = (name: string): string | undefined => {
    const m = payload.match(new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^\\n]+)`, "i"));
    return m ? m[1].trim() : undefined;
  };

  const from = grab("From");
  const to = grab("To");
  const subject = grab("Subject");

  // Body is everything after the first blank line (RFC 822 separator).
  const blank = payload.search(/\n\s*\n/);
  const body = blank >= 0 ? payload.slice(blank).replace(/^\s+/, "") : undefined;

  return { from, to, subject, body };
}

// ───────────────────────────────────────────────────────────────────────
// File operations
// ───────────────────────────────────────────────────────────────────────

function summarizeWrite(input: Record<string, unknown>): Rendered {
  const filePath = (input.file_path ?? input.path) as string;
  const content = (input.content ?? input.data ?? input.body) as string | undefined;
  if (!filePath) return { title: "Create file", kind: "file_create" };
  const shortPath = shortenPath(filePath);
  const sensitive = /\.(env|pem|key|secret|token)/.test(filePath);
  const title = sensitive ? "Create sensitive file" : "Create file";

  let annotation: string | undefined;
  let body: string | undefined;
  if (typeof content === "string") {
    const bytes = Buffer.byteLength(content, "utf8");
    annotation = `(${formatByteCount(bytes)})`;
    if (content.trim()) {
      body = content.length > BODY_PREVIEW_MAX
        ? content.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "…"
        : content;
    }
  }
  return { title, target: shortPath, annotation, body, kind: "file_create" };
}

function summarizeEdit(input: Record<string, unknown>): Rendered {
  const filePath = input.file_path as string;
  if (!filePath) return { title: "Edit file", kind: "file_edit" };
  const shortPath = shortenPath(filePath);
  const oldString = input.old_string as string | undefined;
  const newString = input.new_string as string | undefined;

  if (typeof oldString === "string" && typeof newString === "string") {
    const diff = miniDiff(oldString, newString);
    let footnote: string | undefined;
    let body = diff.lines.slice(0, DIFF_HUNK_MAX_LINES).join("\n");
    if (diff.lines.length > DIFF_HUNK_MAX_LINES) {
      footnote = `… and ${diff.lines.length - DIFF_HUNK_MAX_LINES} more lines`;
    }
    return {
      title: "Edit file",
      target: shortPath,
      annotation: `+${diff.added} −${diff.removed}`,
      body,
      footnote,
      kind: "file_edit",
    };
  }
  return { title: "Edit file", target: shortPath, kind: "file_edit" };
}

function miniDiff(oldStr: string, newStr: string): { lines: string[]; added: number; removed: number } {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  const lines: string[] = [];
  // Naive diff: emit `- oldLine` then `+ newLine` for the changed block.
  // Keep up to a couple of unchanged surrounding lines.
  for (const l of oldLines) lines.push(`- ${l}`);
  for (const l of newLines) lines.push(`+ ${l}`);
  return { lines, added: newLines.length, removed: oldLines.length };
}

function summarizeNotebookEdit(input: Record<string, unknown>): Rendered {
  const filePath = input.file_path as string;
  return filePath
    ? { title: "Edit notebook", target: shortenPath(filePath), kind: "file_edit" }
    : { title: "Edit notebook", kind: "file_edit" };
}

// ───────────────────────────────────────────────────────────────────────
// Agents & MCP
// ───────────────────────────────────────────────────────────────────────

function summarizeAgent(input: Record<string, unknown>): Rendered {
  const prompt = input.prompt as string;
  if (!prompt) return { title: "Launch sub-agent", kind: "agent_launch" };
  const short = truncate(prompt, 80);
  return { title: "Launch sub-agent", body: short, kind: "agent_launch" };
}

/**
 * Built-in browser pane / Claude in Chrome. The tool names (`computer`,
 * `javascript_tool`, …) say nothing on their own, so lead with what the step
 * does and use the agent's own `action_summary` as the target when present.
 */
function summarizeBrowser(tool: string, input: Record<string, unknown>, server: string): Rendered {
  const where = server === "claude-in-chrome" ? "in Chrome" : "in browser";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const summary = str(input.action_summary);

  switch (tool) {
    case "navigate": {
      const url = str(input.url);
      return { title: `Open page ${where}`, target: url ? truncate(url, 80) : undefined, kind: "browser_navigate" };
    }
    case "preview_start": {
      const url = str(input.url);
      if (url) return { title: `Open page ${where}`, target: truncate(url, 80), kind: "browser_navigate" };
      const name = str(input.name);
      return {
        title: name ? `Start dev server "${truncate(name, 40)}"` : "Start dev server",
        footnote: "Runs the command configured in .claude/launch.json",
        kind: "browser_dev_server",
      };
    }
    case "computer": {
      const action = str(input.action) || "action";
      const text = str(input.text);
      return {
        title: `${action.replace(/_/g, " ")} ${where}`.replace(/^./, (c) => c.toUpperCase()),
        target: summary,
        body: text ? truncateBody(text) : undefined,
        kind: "browser_interact",
      };
    }
    case "form_input": {
      const value = input.value;
      return {
        title: `Fill form field ${where}`,
        target: summary,
        body: value !== undefined ? truncateBody(String(value)) : undefined,
        kind: "browser_interact",
      };
    }
    case "javascript_tool": {
      const code = str(input.text);
      return { title: `Run JavaScript ${where}`, body: code ? truncateBody(code) : undefined, kind: "browser_script" };
    }
    case "browser_batch": {
      const actions = Array.isArray(input.actions) ? input.actions : [];
      const steps = actions.map((a) => {
        const name = str((a as { name?: unknown })?.name) || "step";
        const inp = ((a as { input?: unknown })?.input ?? {}) as Record<string, unknown>;
        const r = summarizeBrowser(name, inp, server);
        return r.target ? `${r.title}: ${r.target}` : r.title;
      });
      return {
        title: `Run ${actions.length} browser step${actions.length === 1 ? "" : "s"}`,
        body: steps.length ? truncateBody(steps.join("\n")) : undefined,
        kind: "browser_interact",
      };
    }
  }
  return { title: `${tool.replace(/_/g, " ")} ${where}`.replace(/^./, (c) => c.toUpperCase()), target: summary, kind: "unknown_tool" };
}

function summarizeMcp(toolName: string, input: Record<string, unknown>): Rendered {
  const parts = toolName.split("__");
  // claude.ai connectors have a UUID as the server name. The UUID means nothing to the approver.
  // Desktop app tools have internal server names (ccd_host, ccd_pr).
  const server = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] || "")
    ? "claude.ai connector"
    : /^ccd_/.test(parts[1] || "")
      ? "Claude desktop app"
      : parts[1] || "unknown";
  const tool = parts[2] || "";

  if (parts.includes("ccd_directory") && (tool === "change_directory" || tool === "request_directory")) {
    const dir = typeof input.path === "string" && input.path.trim() ? shortenPath(input.path.trim()) : undefined;
    if (tool === "change_directory") {
      return { title: "Move session to folder", target: dir, footnote: "Claude can read and change files in this folder", kind: "folder_access" };
    }
    return dir
      ? { title: "Give session access to folder", target: dir, footnote: "Claude can read and change files in this folder", kind: "folder_access" }
      : { title: "Ask you to pick a folder for this session", kind: "folder_access" };
  }

  const desktop = summarizeDesktopApp(parts[1] || "", tool, input);
  if (desktop) return desktop;

  const browser = parts.slice(1, -1).find((p) => p === "Claude_Browser" || p === "claude-in-chrome");
  if (browser) return summarizeBrowser(parts[parts.length - 1] || "", input, browser);

  if (tool === "send_email") return summarizeEmail(input);
  if (tool === "send_message") return summarizeMessage(input, server);
  if (tool === "charge_card" || tool === "create_payment" || tool.includes("payment") || tool.includes("charge")) {
    return summarizePayment(tool, input, server);
  }
  if (tool === "query_database") {
    return { title: `Run SQL query via ${server}`, body: input.query as string, kind: "mcp_query" };
  }
  if (tool === "submit_form") {
    const url = (input.url as string) || "";
    const host = url ? extractHost(url) : null;
    return { title: host ? `Submit form at ${host} via ${server}` : `Submit form via ${server}`, kind: "mcp_submit_form" };
  }
  if (tool.startsWith("delete_")) {
    const target = identifyTarget(input);
    const thing = toWords(tool.replace("delete_", ""));
    return target
      ? { title: `Delete ${thing}`, target, annotation: `via ${server}`, kind: "mcp_delete" }
      : { title: `Delete ${thing} via ${server}`, kind: "mcp_delete" };
  }
  if (tool.startsWith("update_")) {
    const target = identifyTarget(input);
    const thing = toWords(tool.replace("update_", ""));
    return target
      ? { title: `Update ${thing}`, target, annotation: `via ${server}`, kind: "mcp_update" }
      : { title: `Update ${thing} via ${server}`, kind: "mcp_update" };
  }
  if (tool.startsWith("create_")) {
    const name = (input.title ?? input.name ?? input.subject ?? null) as string | null;
    const thing = toWords(tool.replace("create_", ""));
    return {
      title: name ? `Create ${thing} "${truncate(name, 40)}" via ${server}` : `Create ${thing} via ${server}`,
      kind: "mcp_create",
    };
  }
  if (tool.startsWith("post_") || tool.startsWith("publish_")) {
    const verb = tool.startsWith("post_") ? "Post" : "Publish";
    const thing = toWords(tool.replace(/^(post|publish)_/, ""));
    const name = (input.title ?? input.name ?? input.tag ?? null) as string | null;
    return {
      title: name ? `${verb} ${thing} "${truncate(name, 40)}" via ${server}` : `${verb} ${thing} via ${server}`,
      kind: tool.startsWith("post_") ? "mcp_post" : "mcp_publish",
    };
  }
  if (tool.startsWith("send_")) {
    const thing = toWords(tool.replace("send_", ""));
    const to = (input.to ?? input.recipient ?? input.user ?? null) as string | null;
    return {
      title: to ? `Send ${thing} to ${to} via ${server}` : `Send ${thing} via ${server}`,
      kind: "mcp_send",
    };
  }
  if (tool === "fill" || tool === "type") {
    const selector = (input.selector as string) || (input.locator as string) || "field";
    const value = (input.value as string) || "";
    return { title: `Fill ${selector} via ${server}`, body: value || undefined, kind: "mcp_fill" };
  }
  if (tool === "submit") {
    const selector = (input.selector as string) || (input.locator as string) || "form";
    return { title: `Submit ${selector} via ${server}`, kind: "mcp_submit" };
  }
  if (tool.startsWith("list_") || tool.startsWith("get_") || tool.startsWith("search_")) {
    return { title: `${toSentence(tool)} via ${server}`, kind: "unknown_tool" };
  }
  return { title: `${toSentence(tool)} via ${server}`, kind: "unknown_tool" };
}

/** Desktop app tools whose name alone does not say what they do. */
function summarizeDesktopApp(server: string, tool: string, input: Record<string, unknown>): Rendered | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (server === "Claude_Code_iOS_Simulator" && tool === "control") return summarizeSimulator(input);
  if (server === "scheduled-tasks") {
    const name = str(input.title) ?? str(input.taskId);
    const when = str(input.cronExpression) ? `cron ${str(input.cronExpression)}` : str(input.fireAt) ? `once at ${str(input.fireAt)}` : undefined;
    const verb = { create_scheduled_task: "Create a scheduled task", update_scheduled_task: "Change a scheduled task",
      run_scheduled_task: "Run a scheduled task now", delete_scheduled_task: "Delete a scheduled task" }[tool];
    if (verb) {
      const change = tool === "update_scheduled_task"
        ? [input.prompt !== undefined ? "prompt" : "", when ? "schedule" : "", input.enabled === false ? "pause" : input.enabled === true ? "resume" : ""].filter(Boolean).join(", ")
        : "";
      return {
        title: verb,
        target: name,
        annotation: [when, change ? `changes: ${change}` : ""].filter(Boolean).join(" · ") || undefined,
        body: str(input.prompt),
        footnote: tool === "create_scheduled_task" ? "Claude runs this prompt on its own on this schedule" : undefined,
        kind: "schedule",
      };
    }
  }
  if (server === "ccd_turn" && tool === "update_plan") {
    return { title: "Update the task list in the Claude app", kind: "session_housekeeping" };
  }
  if (server === "ccd_turn" && tool === "wrap_up") {
    return { title: "Show the end-of-turn summary in the Claude app", body: str(input.recap), kind: "session_housekeeping" };
  }
  if (server === "ccd_session" && (tool === "start_session" || tool === "hand_off_to_session")) {
    const where = input.target === "cloud" ? "in the cloud" : input.target === "ssh" ? `on ${str(input.host) ?? "an SSH host"}` : undefined;
    const title = tool === "hand_off_to_session" ? "Move this task to a new Claude session" : "Start a new Claude session";
    return {
      title: where ? `${title} ${where}` : title,
      target: str(input.title),
      body: str(input.prompt) ?? str(input.remaining_plan),
      kind: "session_start",
    };
  }
  return null;
}

/** The desktop app's iOS Simulator tool: one `control` tool, many actions. */
function summarizeSimulator(input: Record<string, unknown>): Rendered {
  const a = typeof input.action === "string" ? input.action : "";
  const at = typeof input.x === "number" && typeof input.y === "number" ? `(${input.x}, ${input.y})` : undefined;
  const titles: Record<string, string> = {
    attach: "Show the iOS Simulator panel", detach: "Close the iOS Simulator panel", screenshot: "Take an iOS Simulator screenshot",
    launch: "Install and open an app in the iOS Simulator", tap: "Tap in the iOS Simulator", swipe: "Swipe in the iOS Simulator",
    touch_path: "Drag in the iOS Simulator", touch2_path: "Pinch or rotate in the iOS Simulator", text: "Type text in the iOS Simulator",
    button: "Press a button in the iOS Simulator", open_url: "Open a link in the iOS Simulator",
  };
  const target = a === "launch" ? (typeof input.bundle_id === "string" ? input.bundle_id : typeof input.app_path === "string" ? shortenPath(input.app_path) : undefined)
    : a === "open_url" ? (input.url as string | undefined)
    : a === "button" ? (input.name as string | undefined)
    : at;
  return {
    title: titles[a] ?? `Use the iOS Simulator${a ? ` (${a})` : ""}`,
    target,
    body: a === "text" && typeof input.text === "string" ? input.text : undefined,
    kind: "simulator",
  };
}

function identifyTarget(input: Record<string, unknown>): string | null {
  const id = input.id ?? input.name ?? input.path ?? input.target ?? input.repo ?? input.repository ?? null;
  if (id == null) return null;
  if (typeof id === "number") return `#${id}`;
  if (typeof id === "string") return /^\d+$/.test(id) ? `#${id}` : id;
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// Email / payment / chat message — sentence-style
// ───────────────────────────────────────────────────────────────────────

function summarizeEmail(input: Record<string, unknown>): Rendered {
  const join = (v: unknown): string | null => {
    if (Array.isArray(v)) return v.filter((x) => x != null && x !== "").map(String).join(", ") || null;
    if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  };

  const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim() : null;
  const to = join(input.to ?? input.recipient ?? input.recipients);
  const cc = join(input.cc);
  const bcc = join(input.bcc);
  const from = join(input.from ?? input.sender);
  const senderDomain = from && from.includes("@") ? from.split("@")[1].toLowerCase() : null;
  const body = (input.body ?? input.text ?? input.html ?? input.message) as unknown;
  const attachments = input.attachments;

  const title = subject ? `Send "${truncate(subject, 60)}"` : (to ? `Send email to ${truncate(to, 60)}` : "Send email");

  const sublineParts: string[] = [];
  if (subject && to) sublineParts.push(`to ${flagExternal(to, senderDomain)}`);
  if (cc) sublineParts.push(`cc ${flagExternal(cc, senderDomain)}`);
  if (bcc) sublineParts.push(`bcc ${flagExternal(bcc, senderDomain)}`);
  if (from && (subject || to)) sublineParts.push(`from ${from}`);

  if (Array.isArray(attachments) && attachments.length) {
    const list = attachments.map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object") {
        const name = (a as any).name ?? (a as any).filename ?? "attachment";
        const size = (a as any).size;
        return typeof size === "number" ? `${name} (${formatByteCount(size)})` : String(name);
      }
      return String(a);
    });
    sublineParts.push(`📎 ${list.join(", ")}`);
  }

  let bodyText: string | undefined;
  if (typeof body === "string" && body.trim()) {
    bodyText = body.length > BODY_PREVIEW_MAX
      ? body.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "…"
      : body;
  }

  return {
    title,
    subline: sublineParts.length ? sublineParts.join("\n") : undefined,
    body: bodyText,
    kind: "email_send",
  };
}

function flagExternal(recipients: string, senderDomain: string | null): string {
  if (!senderDomain) return recipients;
  const parts = recipients.split(/,\s*/);
  const external = parts.some((p) => {
    const m = p.match(/@([\w.-]+)/);
    return m && m[1].toLowerCase() !== senderDomain;
  });
  return external ? `${recipients}  (external)` : recipients;
}

function summarizePayment(tool: string, input: Record<string, unknown>, server: string): Rendered {
  const amount = formatMoney(input.amount, input.currency);
  const card = (input.card as string) || "";
  const last4 = (input.last4 ?? input.last_four ?? (card.length >= 4 ? card.slice(-4) : null)) as string | null;
  const merchant = (input.merchant ?? input.payee ?? input.to) as string | undefined;
  const memo = (input.memo ?? input.note) as string | undefined;

  let title: string;
  let kind: OperationKind;
  if (tool === "charge_card") {
    title = last4 ? `Charge ${amount} to card ending ${last4}` : `Charge ${amount}`;
    kind = "payment_charge";
  } else if (merchant) {
    title = `Send ${amount} to ${merchant}`;
    kind = "payment_create";
  } else {
    title = `Create ${amount} payment via ${server}`;
    kind = "payment_create";
  }

  const sublineParts: string[] = [];
  if (tool === "charge_card" && merchant) sublineParts.push(`merchant ${merchant}`);
  if (typeof memo === "string" && memo.trim()) sublineParts.push(`memo: ${memo.trim()}`);

  return {
    title,
    subline: sublineParts.length ? sublineParts.join("\n") : undefined,
    kind,
  };
}

function summarizeMessage(input: Record<string, unknown>, server: string): Rendered {
  const to = (input.to ?? input.chat_id ?? input.channel ?? input.recipient) as string | undefined;
  const text = (input.text ?? input.message) as unknown;
  const title = to ? `Send ${prettyServer(server)} message to ${to}` : `Send ${prettyServer(server)} message`;
  let body: string | undefined;
  if (typeof text === "string" && text.trim()) {
    body = text.length > BODY_PREVIEW_MAX
      ? text.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "…"
      : text;
  }
  return { title, body, kind: "chat_message" };
}

function prettyServer(server: string): string {
  if (server === "slack") return "Slack";
  if (server === "discord") return "Discord";
  if (server === "whatsapp") return "WhatsApp";
  if (server === "telegram") return "Telegram";
  return server;
}

// ───────────────────────────────────────────────────────────────────────
// Fallback
// ───────────────────────────────────────────────────────────────────────

/**
 * Claude Code built-ins. Their names (`TaskStop`, `CronCreate`, …) and raw
 * fields (`task_id: bkm34a6nc`) mean nothing on an approval card, so say what
 * the step does. Returns null for other tools.
 */
function summarizeSessionTool(toolName: string, input: Record<string, unknown>): Rendered | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  switch (toolName) {
    case "TaskStop":
    case "KillShell":
      return {
        title: "Stop background task",
        target: str(input.task_id) ?? str(input.shell_id),
        footnote: "Only a task this session started",
        kind: "session_control",
      };
    case "EnterWorktree":
      return { title: "Create a git worktree for this session", target: str(input.name), kind: "worktree" };
    case "ExitWorktree":
      if (input.action !== "remove") return { title: "Leave worktree (keep it on disk)", kind: "worktree" };
      return input.discard_changes === true
        ? { title: "Delete worktree and discard its changes", footnote: "Uncommitted files and unmerged commits are lost", kind: "worktree" }
        : { title: "Delete worktree", footnote: "Refused if it has unsaved changes", kind: "worktree" };
    case "CronCreate": {
      const prompt = str(input.prompt);
      return {
        title: input.recurring === false ? "Schedule a one-time prompt" : "Schedule a recurring prompt",
        target: str(input.cron),
        body: prompt ? truncateBody(prompt) : undefined,
        kind: "schedule",
      };
    }
    case "CronDelete":
      return { title: "Delete scheduled prompt", target: str(input.id) ?? str(input.job_id), kind: "schedule" };
    case "SendMessage": {
      const message = str(input.message);
      return {
        title: str(input.to) ? `Send message to agent "${truncate(str(input.to)!, 40)}"` : "Send message to agent",
        body: message ? truncateBody(message) : undefined,
        kind: "agent_message",
      };
    }
    case "WebFetch": {
      const url = str(input.url);
      return { title: "Fetch web page", target: url ? truncate(url, 80) : undefined, kind: "web_fetch" };
    }
    case "Monitor": {
      const cmd = str(input.command);
      const ws = str((input.ws as { url?: unknown } | undefined)?.url);
      return {
        title: str(input.description) ? `Watch: ${truncate(str(input.description)!, 60)}` : "Start background watcher",
        target: ws ? truncate(ws, 80) : undefined,
        body: cmd ? truncateBody(cmd) : undefined,
        kind: "monitor",
      };
    }
    case "Artifact": {
      const action = str(input.action) ?? "publish";
      const target = str(input.url) ?? (str(input.file_path) ? shortenPath(str(input.file_path)!) : undefined);
      if (action === "delete") {
        return { title: "Delete page from claude.ai", target, footnote: "The link stops working for everyone", kind: "artifact" };
      }
      if (action === "publish") {
        return {
          title: str(input.url) ? "Update page on claude.ai" : "Publish page to claude.ai",
          target,
          footnote: "Private to you until you share it",
          kind: "artifact",
        };
      }
      return { title: `${action.replace(/_/g, " ")} page on claude.ai`.replace(/^./, (c) => c.toUpperCase()), target, kind: "artifact" };
    }
  }
  return null;
}

function summarizeFallback(toolName: string, toolInput: Record<string, unknown>): Rendered {
  const keys = Object.keys(toolInput);
  if (!keys.length) return { title: toolName, kind: "unknown_tool" };
  const summary = keys
    .map((k) => {
      const v = toolInput[k];
      const val = typeof v === "string" ? truncate(v, 60) : truncate(JSON.stringify(v), 60);
      return `${k}: ${val}`;
    })
    .join("\n");
  return { title: toolName, body: summary, kind: "unknown_tool" };
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function formatMoney(amount: unknown, currency: unknown): string {
  const num = typeof amount === "number" ? amount : parseFloat(String(amount));
  if (isNaN(num)) return String(amount);
  const cur = String(currency || "").toLowerCase();
  const symbols: Record<string, string> = { usd: "$", eur: "€", gbp: "£", jpy: "¥", cad: "CA$", aud: "A$" };
  const symbol = symbols[cur] || (cur ? cur.toUpperCase() + " " : "");
  const wholeCurrencies = ["jpy", "krw", "vnd", "clp"];
  const isWhole = wholeCurrencies.includes(cur);
  const value = isWhole ? num : num / 100;
  return `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Words shown in capitals. Only known acronyms: uppercasing every short word
// turned "wrap_up" into "Wrap UP" and "get_repo" into "GET repo".
const ACRONYMS = new Set(["pr", "prs", "url", "api", "sql", "ci", "id", "ids", "ui", "dns", "ssh", "sms", "pdf", "csv", "json", "html", "css", "aws", "gcp", "db", "vm", "ip", "mcp", "otp", "llm"]);

function toWords(snake: string): string {
  return snake.replace(/_/g, " ").split(" ").map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(" ");
}

// "set_auto_merge" -> "Set auto merge", "bind_pr" -> "Bind PR": the first word
// is a verb, so it is not read as an acronym.
function toSentence(snake: string): string {
  const [first = "", ...rest] = snake.split("_");
  const head = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return rest.length ? `${head} ${toWords(rest.join("_"))}` : head;
}

function shortenPath(filePath: string): string {
  return filePath
    .replace(/^\/home\/[^/]+\//, "~/")
    .replace(/^\/Users\/[^/]+\//, "~/");
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function parseRmTargets(argsString: string): string[] {
  const targets: string[] = [];
  const str = argsString.trim();
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i++;
    if (i >= str.length) break;

    // A shell command separator (`;`, `|`, `||`, `&&`, `&`), a redirect (`>`,
    // `>>`, `2>`, `&>`), a closing `)`/`}`, a comment, or a newline ends the rm
    // argument list — everything after belongs to a different command. Without
    // this, a compound `if …; then rm -rf "$P"; else echo "…"; fi` would sweep
    // the trailing `;`/`else`/`echo`/`fi` (and the echo's text) in as "files",
    // rendering a bogus "Delete N files recursively".
    if (/^(?:&?\d*[<>]|[;|&`)}#\n])/.test(str.slice(i))) break;

    let token: string;
    if (str[i] === '"') {
      const close = str.indexOf('"', i + 1);
      if (close === -1) { token = str.slice(i + 1); i = str.length; }
      else { token = str.slice(i + 1, close); i = close + 1; }
    } else if (str[i] === "'") {
      const close = str.indexOf("'", i + 1);
      if (close === -1) { token = str.slice(i + 1); i = str.length; }
      else { token = str.slice(i + 1, close); i = close + 1; }
    } else {
      const start = i;
      // Stop the bare token at whitespace OR a separator/redirect char, so
      // `"$P";` and `$P;` both yield just the path.
      while (i < str.length && !/[\s;|&<>`)}#]/.test(str[i])) i++;
      token = str.slice(start, i);
    }

    if (token && !token.startsWith("-")) {
      targets.push(token);
    }
  }
  return targets;
}

/** What a kill stops: a pattern, process names, a port, or process ids. */
function killTarget(step: string): { title: string; target?: string } {
  const line = step.split(/\n|;|&&|\|\|/)[0].trim();
  const words = (s: string) => (s.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));
  if (/^pkill\b/.test(line)) {
    const w = words(line.replace(/\|.*$/, "")).slice(1).filter((x) => !/^-(?!f$)/.test(x));
    const f = w.indexOf("-f");
    return { title: "Stop processes matching", target: (f >= 0 ? w[f + 1] : w[w.length - 1]) || undefined };
  }
  if (/^killall\b/.test(line)) {
    return { title: "Stop processes named", target: words(line).slice(1).filter((x) => !x.startsWith("-")).join(", ") || undefined };
  }
  const port = line.match(/lsof\b[^)]*?-i\s*(?:tcp|TCP|udp)?:?(\d+)|-iTCP:(\d+)/);
  if (port) return { title: "Stop the process on port", target: port[1] ?? port[2] };
  const pg = line.match(/\$\(\s*pgrep\s+(?:-\w+\s+)*(?:-f\s+)?(['"]?)(.+?)\1\s*\)/);
  if (pg) return { title: "Stop processes matching", target: pg[2] };
  const pids = words(line).slice(1).filter((x) => /^\d+$/.test(x));
  if (pids.length) return { title: pids.length === 1 ? "Stop process" : "Stop processes", target: `PID ${pids.join(", ")}` };
  return { title: "Stop processes" };
}

/** `python3 - <<'EOF' … EOF` (one step): "Run a Python script" with the script as the body. */
function summarizeCodeHeredoc(cmd: string): Rendered | null {
  if (splitTopLevel(cmd).length > 1) return null;
  const m = cmd.match(/^(?:\w+=\S+\s+)*(?:sudo\s+)?(node|python\d?(?:\.\d+)?|ruby|perl|deno|bun)\b[^\n]*<<-?\s*(["']?)([A-Za-z_]\w*)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*$/);
  if (!m) return null;
  const lang = m[1].startsWith("python") ? "Python" : m[1] === "node" ? "Node" : m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const files = [...m[4].matchAll(/(?:open|readFileSync|writeFileSync|Path)\(\s*['"]([^'"]+)['"]/g)].map((f) => f[1]);
  const edits = /\.write\(|writeFileSync|write_text\(/.test(m[4]);
  return {
    title: edits && files.length ? `Edit file with a ${lang} script` : `Run a ${lang} script`,
    target: files.length ? [...new Set(files)].map(shortenPath).join("\n") : undefined,
    body: truncateBody(m[4]),
    kind: edits ? "file_edit" : "script_run",
  };
}

/** `prisma migrate deploy`: which database, from a DATABASE_URL set in the command. */
function summarizePrismaDeploy(cmd: string): Rendered | null {
  if (!/\bprisma\s+migrate\s+deploy\b/.test(shellText(cmd))) return null;
  const url = cmd.match(/DATABASE_URL=["']?([a-z]+:\/\/[^\s"';&|]+)/)?.[1];
  let db: string | undefined;
  if (url) {
    try {
      const u = new URL(url);
      db = `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
    } catch { /* keep undefined */ }
  }
  return { title: "Apply Prisma database migrations", target: db, annotation: db ? undefined : "to the database in DATABASE_URL", kind: "sql_migrate" };
}

/** The command as the shell runs it: quoted text arguments and inline script
 * bodies (`node -e '…'`) blanked, so words in them do not name the card. */
function shellText(cmd: string): string {
  return blankTextCommandArgs(stripInlineScriptBodies(cmd));
}

const GIT_C_RE = /\bgit\s+-C\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s+/;

/** The folder a shell is in after these steps, following each `cd`. Unknown
 *  when a `cd` goes to a relative path with no known start, or to `$VAR`. */
function cwdAfterCds(steps: string[], vars: Map<string, string>, cwd?: string): string | undefined {
  let dir = cwd;
  for (const s of steps) {
    const m = s.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*$/);
    if (m) dir = resolveDir(stripQuotes(expandVars(m[1], vars)), dir);
  }
  return dir;
}

function resolveDir(dir: string, base?: string): string | undefined {
  const d = dir.replace(/^~(?=\/|$)/, homedir());
  if (d.includes("$")) return undefined;
  return isAbsolute(d) ? d : base ? resolve(base, d) : undefined;
}

interface GitRepo {
  name: string;                  // owner/name from origin, else the folder name
  remotes: Map<string, string>;  // remote name → URL
  branch?: string;               // checked-out branch
}

/** The repo the git command matched by `re` runs in: after the `cd` steps
 *  before it, and its own `git -C`. */
function gitRepoFor(cmd: string, re: RegExp, cwd?: string): GitRepo | null {
  const m = re.exec(cmd);
  if (!m) return null;
  const before = splitTopLevel(cmd.slice(0, m.index), { pipes: false });
  let dir = cwdAfterCds(before, literalAssignments(cmd), cwd);
  const c = m[0].match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)?.[1];
  if (c) dir = resolveDir(stripQuotes(expandVars(c, literalAssignments(cmd))), dir);
  return dir ? readGitRepo(dir) : null;
}

function readGitRepo(start: string): GitRepo | null {
  try {
    for (let top = resolve(start); ; top = dirname(top)) {
      const dotGit = join(top, ".git");
      if (existsSync(dotGit)) {
        // A worktree's `.git` is a file that points at its git dir, which
        // points at the main repo's git dir (`commondir`).
        let gitDir = dotGit;
        const pointer = statSync(dotGit).isFile() ? readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m) : null;
        if (pointer) gitDir = resolve(top, pointer[1].trim());
        const commonFile = join(gitDir, "commondir");
        const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
        const remotes = new Map<string, string>();
        let section: string | undefined;
        for (const line of readFileSync(join(commonDir, "config"), "utf8").split("\n")) {
          const head = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
          if (head) section = head[1];
          else if (/^\s*\[/.test(line)) section = undefined;
          else if (section && !remotes.has(section)) {
            const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1];
            if (url) remotes.set(section, url);
          }
        }
        const head = existsSync(join(gitDir, "HEAD")) ? readFileSync(join(gitDir, "HEAD"), "utf8") : "";
        const mainTop = basename(commonDir) === ".git" ? dirname(commonDir) : top;
        return {
          name: repoSlug(remotes.get("origin")) ?? basename(mainTop),
          remotes,
          branch: head.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)?.[1],
        };
      }
      if (dirname(top) === top) return null;
    }
  } catch {
    return null;
  }
}

/** `git@github.com:oked-ai/oked-sdk.git` or `https://github.com/oked-ai/oked-sdk` → `oked-ai/oked-sdk`. */
function repoSlug(url?: string): string | undefined {
  const path = url?.match(/^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[^@\s/]+@[^:\s]+:)(.+?)(?:\.git)?\/?$/i)?.[1];
  return path?.split("/").slice(-2).join("/") || undefined;
}

/** `NAME=value` assignments with a literal value (no `$(…)`, no backticks), in order. */
function literalAssignments(cmd: string): Map<string, string> {
  const vars = new Map<string, string>();
  const re = /(?:^|[;&|\n(]\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"$`]*"|'[^']*'|[^\s;&|$`'"()]+)(?=[\s;&|)]|$)/g;
  for (const m of cmd.matchAll(re)) vars.set(m[1], m[2].replace(/^["']|["']$/g, ""));
  return vars;
}

function expandVars(token: string, vars: Map<string, string>): string {
  return token.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => vars.get(name) ?? whole);
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

function truncateBody(s: string): string {
  return s.length > BODY_PREVIEW_MAX ? s.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "…" : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Return the portion of `trimmed` starting at `startIdx` up to (but not
// including) the next SQL statement keyword, so WHERE-checks don't bleed
// across statement boundaries when multiple statements are joined.
function stmtSlice(trimmed: string, startIdx: number): string {
  const after = trimmed.slice(startIdx);
  // Skip past the first keyword+table-name before looking for the next stmt
  const nextKw = after.slice(10).search(/\b(DELETE|INSERT|UPDATE|DROP|CREATE|ALTER|TRUNCATE)\b/i);
  return nextKw >= 0 ? after.slice(0, nextKw + 10) : after;
}
