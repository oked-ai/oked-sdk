import path from "path";
import os from "os";
import type { RiskTier } from "./types.js";
import { findSqlInCommand } from "./describe.js";
import { TIER_ORDER } from "./degraded.js";

// Classification is EFFECT-BASED, not command-name-based. We don't keep an
// allowlist of "safe commands"; instead we detect the few categories of effect
// that warrant a human in the loop, and DEFAULT TO NO PROMPT for everything
// else. Running a command, reading, copying a file, a DB SELECT, or deleting a
// /tmp scratch file must never prompt — only destructive, irreversible, or
// outward-facing operations do.
//
// Tier 1 - safe: auto-allow, silent. No detected side effect (reads, queries,
//                and any command we don't recognize as mutating — the default).
// Tier 2 - warning: terminal log only, no push. A reversible LOCAL mutation
//                (file create/copy/move, /tmp delete, local git, install,
//                code-exec, SQL INSERT/CREATE).
// Tier 3 - review: push notification, tap to approve. Prompt-worthy but not
//                catastrophic: sensitive-path writes (~/.ssh, shell rc, system
//                dirs, OKed's own config), sudo, outward message/email sends.
// Tier 4 - high_stakes: push + number matching. Destructive / irreversible /
//                external: rm of non-temp data, DROP/TRUNCATE/DELETE FROM,
//                git push --force / reset --hard / branch -D, mkfs / dd-to-device /
//                shutdown, curl POST/DELETE, ssh/scp, npm publish, kill.

// Tools that are always safe (read-only, no side effects)
const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "TodoRead",
  "TaskGet",
  "TaskList",
]);

// Read-only tools from non-Claude-Code agents (OpenClaw `read`/`list`,
// Codex `read_file`, etc.). Claude Code's own Read/Glob/Grep are covered by
// SAFE_TOOLS above; this catches the same read-only operations under other
// agents' (often lowercase) names so they don't fall through to `review`.
const SAFE_TOOL_ALIASES = new Set([
  "read",
  "read_file",
  "readfile",
  "view",
  "cat",
  "list",
  "list_files",
  "listfiles",
  "ls",
  "glob",
  "grep",
  "search",
  "search_files",
  "find",
]);

// Claude Code built-ins that only steer the session itself (its background
// tasks, todo list, plan mode, tool loading, questions to the user) or show
// something to the user. They touch no files, network or other process, so a
// prompt is pure approval fatigue.
const SAFE_SESSION_TOOLS = new Set([
  "TaskStop",
  "KillShell",
  "TaskOutput",
  "BashOutput",
  "TaskCreate",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "Skill",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ListAgents",
  "CronList",
  "ScheduleWakeup",
  "LSP",
  "ReportFindings",
  "SendUserFile",
  "PushNotification",
]);

// Claude Code built-ins with a small effect: a new worktree, a session-only
// scheduled prompt, a message to another agent, a web page fetch. Logged, not
// prompted; whatever they lead to (the scheduled prompt's tool calls, the other
// agent's actions) is gated on its own.
const WARNING_SESSION_TOOLS = new Set([
  "EnterWorktree",
  "CronCreate",
  "CronDelete",
  "SendMessage",
  "WebFetch",
]);

/** Built-ins whose tier depends on their input. Returns null for other tools. */
function classifySessionTool(toolName: string, toolInput: Record<string, unknown>): RiskTier | null {
  switch (toolName) {
    // "keep" leaves everything on disk. "remove" refuses when there is
    // unsaved work, unless discard_changes deletes it for good.
    case "ExitWorktree":
      if (toolInput.action !== "remove") return "safe";
      return toolInput.discard_changes === true ? "high_stakes" : "warning";
    // Monitor runs a shell command (classified like Bash) or reads a WebSocket.
    case "Monitor":
      if (typeof toolInput.command === "string") return classifyBashCommand(toolInput.command);
      return "warning";
    // Artifact: publishing puts content on claude.ai; delete is permanent;
    // read / list / open / quickstart / pin only look or arrange.
    case "Artifact": {
      const action = typeof toolInput.action === "string" ? toolInput.action : "publish";
      if (action === "delete") return "high_stakes";
      if (action === "publish") return "review";
      return "safe";
    }
  }
  return null;
}

// Tools that are always review-tier risk (modify local files)
const REVIEW_TOOLS = new Set<string>([]);

// Tools that are always high stakes
const HIGH_STAKES_TOOLS = new Set<string>([]);

// NOTE: there is intentionally NO "safe commands" allowlist. Under the
// effect-based model, anything we don't detect as a mutation or a prompt-worthy
// effect IS safe by default (reads, queries, `ls`, `grep`, `jq`, `awk`, `sort`,
// unknown commands, …). We only enumerate the things that DO warrant a log
// (WARNING_*) or a prompt (REVIEW_*, HIGH_STAKES_*).

// File deletion (rm/rmdir/trash), detected in COMMAND POSITION only. Checked
// PER-STAGE (not the full command) so the ephemeral-temp downgrade can run
// first. Earlier this matched the bare word `\brm\b` anywhere, which fired on
// `rm` sitting in an ARGUMENT — a branch name (`git push origin fix-rm-thing`),
// a filename (`touch fix-rm.txt`), or echo text — turning benign commands
// (including file creation) into false high_stakes prompts. Now it only fires
// when the delete word is the command being run.
//
// DELETE_LEAD strips leading command wrappers / loop-body keywords (and their
// flags) so a real delete that isn't literally first — `sudo rm`, `command rm`,
// `xargs -0 rm`, `do rm` (from `for …; do rm …; done`) — still anchors at start.
// Wrappers that take their own structured args (env, ssh, NAME=…, sh -c) are
// handled by their dedicated stage classifiers, which recurse into the inner
// command, so they're intentionally not here.
const DELETE_LEAD =
  /^(?:(?:sudo|command|exec|builtin|time|nice|xargs|then|do|else)\b\s*(?:-\S+\s+)*)+/;
// rm/rmdir/trash at the (lead-stripped) start of the stage, at the start of a
// line, or immediately inside a substitution/subshell/group ($( ), `…`, ( ),
// { ). Deliberately NOT after `;`/`|`/`&`/a quote, so a delete word sitting in
// quoted DATA (echo text, a commit message) doesn't match.
const DELETE_COMMAND_RE =
  /(?:^|[\n`({]|\$\()\s*(?:rm|rmdir|trash|trash-put)\b/;

const NPX_DEPLOY_RE = /\bnpx\s+.*\s+deploy\b/;

/**
 * `prisma migrate deploy` against a DATABASE_URL on this machine (localhost,
 * 127.0.0.1, ::1) set in the same command: it changes a local test database,
 * not a live one, so the `npx … deploy` rule does not apply. Without a local
 * DATABASE_URL in the command the URL comes from the environment, which can be
 * production, so the rule still applies.
 */
function isLocalPrismaDeploy(command: string): boolean {
  if (!/\bprisma\s+migrate\s+deploy\b/.test(command)) return false;
  const urls = [...command.matchAll(/DATABASE_URL=["']?([a-z]+:\/\/[^\s"';&|]+)/g)].map((m) => m[1]);
  if (urls.length === 0) return false;
  return urls.every((u) => {
    try {
      return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname);
    } catch {
      return false;
    }
  });
}

// Bash commands classified as high stakes (destructive, irreversible, external).
// Scanned on the FULL command (some patterns, e.g. download|shell, span a pipe).
// File deletion lives in DELETE_PATTERNS (per-stage) instead, see above.
const HIGH_STAKES_COMMANDS = [
  // Force push rewrites remote history irreversibly. A plain push is downgraded
  // to `warning` in WARNING_COMMANDS below. Mirrors describe.ts force detection.
  /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+restore\s+--staged\s+\./,
  // NOTE: SQL severity (DROP/DELETE FROM/TRUNCATE/…) is intentionally NOT matched
  // here. Raw word patterns fire on ordinary text — `grep truncate`, `echo "drop
  // table"` — producing false high_stakes. SQL is handled by findSqlInCommand,
  // which only extracts statements from real SQL contexts (psql/mysql/sqlite3
  // -c/-e, interpreter -e/-c bodies, heredocs), then classifySqlSeverity.
  /\bdocker\s+(rm|rmi|system\s+prune)\b/,
  /\bdocker\s+compose\s+down\b/,
  // NOTE: curl request-method/body flags (-X DELETE, --data, -F, -T, --json, …)
  // are NOT here. Their `.*` would match greedily across a `&&`/`|` boundary and
  // grab a flag belonging to a LATER command (e.g. `curl -o … && unzip … -d dir`
  // false-matched the curl `-d` POST-body pattern on unzip's destination flag).
  // They belong to a single curl invocation, so they're scanned PER-STAGE in
  // HIGH_STAKES_CURL_STAGE below. Only the download-and-execute patterns
  // (`curl|wget … | sh`) genuinely span a pipe and stay in this full scan.
  /\bwget\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bcurl\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bnpm\s+publish\b/,
  /\bnpm\s+unpublish\b/,
  NPX_DEPLOY_RE,
  // NOTE: ssh is intentionally NOT a blanket high_stakes here. ssh is a
  // transport — the real effect is whatever runs on the remote host — so it's
  // classified by its remote command in classifySshStage (a read-only remote
  // diagnostic shouldn't prompt; a destructive one still does). scp/rsync to a
  // remote ARE file transfers (outward writes) and stay in HIGH_STAKES_STAGE.
  // himalaya destructive ops. message delete + folder delete/expunge/purge
  // wipe mail from the server irreversibly; account delete wipes local config.
  /\bhimalaya\s+message\s+delete\b/,
  /\bhimalaya\s+folder\s+(delete|expunge|purge)\b/,
  /\bhimalaya\s+account\s+delete\b/,
  // Overwriting a raw block device (`> /dev/sda`, `… > /dev/nvme0n1`) destroys a
  // disk irreversibly. (dd to a device is in HIGH_STAKES_STAGE.)
  />\s*\/dev\/(sd|nvme|hd|disk|mmcblk|vd)\w*/,
];

// Destructive / irreversible commands matched PER-STAGE at the start of a stage
// (after stripping a leading `sudo `), so the destructive WORD can't be hit
// inside an argument or a commit message (`git commit -m "kill the flaky test"`
// must not be high_stakes). These don't span pipes, so per-stage `^`-anchoring
// is both safe and precise.
const HIGH_STAKES_STAGE = [
  // Filesystem / disk destruction.
  /^mkfs(\.\w+)?\b/,
  /^mkswap\b/,
  /^(fdisk|parted|gparted)\b/,
  /^dd\b.*\bof=\/dev\//,
  /^shred\b/,
  /^truncate\b/,                       // `truncate -s 0 file` wipes contents
  /^find\b.*\s-delete\b/,              // `find … -delete` removes matches
  // Power / system state.
  /^(shutdown|reboot|halt|poweroff)\b/,
  // Remote/outward file transfer (almost always a remote target).
  /^scp\b/,
  /^rsync\b.*(--delete|\s\S+:)/,        // rsync --delete, or to a host:path target
  // Local git history/work destruction (force branch delete, tag delete,
  // dropping/clearing stashed work). Reversible local git (add/commit/stash) is
  // a WARNING marker below.
  /^git\s+branch\s+(?:-D|--delete)\b/,
  /^git\s+tag\s+(?:-d|--delete)\b/,
  /^git\s+stash\s+(?:drop|clear)\b/,
  // Remote branch delete: it leaves the machine and removes the branch for
  // everyone (`git push origin --delete feat`, `git push origin :feat`).
  /^git\s+push\b.*\s(?:--delete|-d)\b/,
  /^git\s+push\b.*\s\+?:[^\s:]+(?:\s|$)/,
  // Process termination.
  /^kill\b/,
  /^pkill\b/,
  /^killall\b/,
  // Wide-open permissions.
  /^chmod\s+(?:-\S+\s+)*777\b/,
  // GitHub CLI: merging a PR changes the base branch for everyone (and often
  // deploys); deletes and archives can't be undone from here.
  /^gh\s+pr\s+merge\b/,
  /^gh\s+(?:repo|release|issue|label|gist|secret|variable|cache|run|ruleset)\s+delete\b/,
  /^gh\s+repo\s+archive\b/,
  // Railway deploys and tear-downs change a live service.
  /^railway\s+(?:up|deploy|redeploy|down|delete)\b/,
];

// curl request-method / request-body flags, scanned PER-STAGE (a single stage
// has no top-level pipe, so `\bcurl\b.*` can't cross into another command — the
// `-d`/`-T`/etc. it finds belongs to THIS curl). A curl that sends a body or a
// mutating method (POST/PUT/PATCH/DELETE) is an outward write → high_stakes.
// A plain `curl -o file URL` download has none of these and stays safe.
const HIGH_STAKES_CURL_STAGE = [
  /\bcurl\s+.*-X\s*(DELETE|PUT|POST|PATCH)\b/i,
  /\bcurl\s+.*--request\s*(DELETE|PUT|POST|PATCH)\b/i,
  // curl flags that send a request body (POST/PUT/PATCH) without an explicit -X
  /\bcurl\b.*\s-d[\s=]/,
  /\bcurl\b.*\s--data(-raw|-binary|-urlencode|-ascii)?[\s=]/,
  /\bcurl\b.*\s-F[\s=]/,
  /\bcurl\b.*\s--form[\s=]/,
  /\bcurl\b.*\s(-T|--upload-file)[\s=]/,
  /\bcurl\b.*\s--json[\s=]/,
];

// Outward-but-recoverable commands → review (prompt, simple approve). Sending
// mail/messages can't be unsent, but it isn't destructive to local state, so it
// sits below high_stakes. Matched per-stage. (Destructive himalaya verbs —
// message delete, folder purge — are high_stakes in the full scan above.)
const REVIEW_COMMANDS = [
  /^himalaya\s+message\s+(send|reply|forward)\b/,
  // GitHub CLI writes other people see (comments, reviews, issues, releases)
  // or that change the repo's settings and CI. They can be edited or undone.
  /^gh\s+pr\s+(?:close|reopen|comment|review|edit|ready|lock|unlock)\b/,
  /^gh\s+issue\s+(?:create|close|reopen|comment|edit|transfer|lock|unlock|pin|unpin)\b/,
  /^gh\s+release\s+(?:create|edit|upload)\b/,
  /^gh\s+repo\s+(?:create|edit|rename|fork)\b/,
  /^gh\s+(?:secret|variable)\s+set\b/,
  /^gh\s+workflow\s+(?:run|enable|disable)\b/,
  /^gh\s+run\s+(?:cancel|rerun)\b/,
  /^gh\s+(?:gist|label)\s+(?:create|edit)\b/,
];

/**
 * `gh api` is curl for GitHub: a mutating method, or fields without a method
 * (gh then sends a POST), is an outward write like a curl POST. A GraphQL call
 * is a write only when it holds a mutation. Returns null for other commands.
 */
function classifyGhApiStage(stage: string): RiskTier | null {
  if (!/^gh\s+api\b/.test(stage)) return null;
  const method = stage.match(/\s(?:-X|--method)(?:\s+|=)?([A-Za-z]+)\b/)?.[1]?.toUpperCase();
  if (method && method !== "GET" && method !== "HEAD") return "high_stakes";
  if (/^gh\s+api\s+graphql\b/.test(stage)) return /\bmutation\b/.test(stage) ? "high_stakes" : "safe";
  if (!method && /\s(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/.test(stage)) return "high_stakes";
  return "safe";
}

// Local-mutation MARKERS for DETECTED side effects. These never gate a prompt —
// under the effect-based model anything not flagged destructive/outward/sensitive
// already auto-allows. They exist only to pick the `warning` (logged) vs `safe`
// (silent) label, and cover the local mutations we can recognize by shape but
// that aren't a plain file write (those are handled by extractShellWriteOps).
//
// Opaque code execution (node/npx/python/claude/test runners) is intentionally
// NOT here: we can't tell whether it mutated anything, and a destructive effect
// buried inside `node -e …` would slip through regardless of the label — so
// logging it adds terminal noise without buying safety. It stays `safe`, just
// like any other unrecognized command. A real file write it performs is a
// separate Bash/Write call that gets classified on its own.
const WARNING_COMMANDS = [
  // Local, reversible git writes — stage/commit/switch/stash. They mutate the
  // local repo but can be undone (amend, reset, checkout). Destructive git
  // (force push, reset --hard, branch -D, stash drop/clear) is caught above and wins.
  /^git\s+add\b/,
  /^git\s+commit\b/,
  /^git\s+checkout\s+-b\b/,
  /^git\s+switch\b/,
  /^git\s+stash\b(?!\s+(?:drop|clear))/,
  // Plain push (no force). Outward, but the remote keeps full history and the
  // push is recoverable, so by policy it logs rather than prompts. Force push is
  // high_stakes in the full scan above and wins before reaching here.
  /^git\s+push\b/,
  /^gh\s+pr\s+create\b/,
  // Prisma migrations reach here only for a local database (see isLocalPrismaDeploy).
  /^(?:\w+=\S+\s+)*npx\s+prisma\s+migrate\s+deploy\b/,
  // Package installs always mutate node_modules and run dependency postinstall
  // scripts — a known local mutation worth an audit line.
  /^npm\s+(install|ci|i|update|upgrade|rebuild|prune|dedupe)\b/,
  /^(pnpm|yarn)\s+(install|add|ci|up|upgrade)\b/,
];

// Ephemeral filesystem locations. Writes here have no lasting effect on
// their own — what matters is whatever subsequent command CONSUMES the file
// (e.g. `himalaya message send < /tmp/draft.eml`). Without this carve-out,
// every multi-step skill that drafts a temp file generates two approval
// prompts (the temp write + the real send) instead of one.
const EPHEMERAL_PATH_RE = /^(?:\/tmp\/|\/var\/tmp\/|\/var\/folders\/|\/private\/tmp\/|\/private\/var\/folders\/|[A-Za-z]:[\\/](?:Windows[\\/]Temp|Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp)[\\/])/i;

// A temp-dir env var (the conventional output of `mktemp -d` etc.): $TMPDIR,
// $TMP, $TEMP, ${TMPDIR}, and paths beneath them. Treated as ephemeral since
// we can't resolve the value but the intent is unambiguous.
const TEMP_VAR_RE = /^\$\{?(?:TMPDIR|TMP|TEMP)\}?(?:\/|$)/;

function isEphemeralPath(filePath: string): boolean {
  if (!filePath) return false;
  return TEMP_VAR_RE.test(filePath) || EPHEMERAL_PATH_RE.test(filePath);
}

// A shell variable assigned from `mktemp` / `mktemp -d` (optionally `export`ed)
// at the start of a stage: `EMPTYHOME=$(mktemp -d)`, `T=`mktemp``. Its value is a
// throwaway temp path the shell just created, so a same-command `rm -rf "$T"`
// that deletes it is the ephemeral-temp case, not a real-data wipe. These names
// are gathered across every stage of a compound command BEFORE any stage is
// classified (see classifyBashCommand), so a delete in a later stage can see a
// binding declared in an earlier one. Safe because the whole binding is visible
// in this single inspected command string — no environment-resolution guess.
const MKTEMP_ASSIGN_RE =
  /^(?:export\s+|declare\s+|local\s+|readonly\s+)?(\w+)=["']?(?:\$\(|`)\s*mktemp\b/;

// Process names and command lines of local dev servers and dev tooling: Node
// and Python app servers, bundlers, package-manager scripts, and Node scripts.
const DEV_PROCESS_RE =
  /\b(?:node|nodemon|tsx|ts-node|vite|next|nuxt|astro|remix|webpack(?:-dev-server)?|esbuild|parcel|turbo|npm|pnpm|yarn|bun|deno|wrangler|miniflare|uvicorn|gunicorn|flask|runserver|rails|puma|http\.server|http-server|live-server|serve|hugo|jekyll|storybook|expo|metro)\b|\.(?:[cm]?js|tsx?)\b/;

/**
 * A kill of a local dev server: `pkill -f "tsx src/main.ts"`, `killall node`,
 * `kill $(pgrep -f vite)`, or a kill of whatever listens on a port
 * (`kill $(lsof -t -iTCP:3000 -sTCP:LISTEN)`). Oren chose `review` (no Face
 * ID) for these on 2026-10-18. A bare `kill <pid>` names no process, so it
 * stays high stakes.
 */
function isDevServerKill(stage: string): boolean {
  const pkill = stage.match(/^pkill\s+(.+)$/);
  if (pkill) {
    const args = splitArgs(pkill[1]).filter((a) => !a.startsWith("-") || a === "-f");
    const pattern = unquote(args[args.indexOf("-f") + 1] ?? args[args.length - 1] ?? "");
    return DEV_PROCESS_RE.test(pattern);
  }
  const killall = stage.match(/^killall\s+(.+)$/);
  if (killall) {
    const names = splitArgs(killall[1]).filter((a) => !a.startsWith("-")).map(unquote);
    return names.length > 0 && names.every((n) => DEV_PROCESS_RE.test(n));
  }
  const kill = stage.match(/^kill\s+(?:-\w+\s+)*\$\((.+)\)\s*(?:2>\/dev\/null)?$/);
  if (kill) {
    const inner = kill[1].trim();
    if (/^lsof\b/.test(inner) && /-i\s*(?:tcp|TCP|udp)?:?\d+|-iTCP:\d+/.test(inner)) return true;
    const pg = inner.match(/^pgrep\s+(?:-\w+\s+)*(?:-f\s+)?(.+)$/);
    if (pg) return DEV_PROCESS_RE.test(unquote(pg[1].trim()));
  }
  return false;
}

// Entries in the ephemeral set that are not variable names: `path:<p>` is a
// file an earlier stage created, `cwd:temp` means the shell is in a temp dir.
const CREATED_PATH = "path:";
const TEMP_CWD = "cwd:temp";
// An earlier stage exported a DATABASE_URL on this machine (see isLocalPrismaDeploy).
const LOCAL_DB = "db:local";

function noteEphemeralEffects(stage: string, into: Set<string>): void {
  const assign = stage.match(/^(?:export\s+)?(\w+)=("[^"$`]*"|'[^']*'|[^\s;&|$`'"()]+)$/);
  if (assign && isEphemeralPath(unquote(assign[2]))) into.add(assign[1]);
  for (const op of extractShellWriteOps(stage)) {
    if (op.kind === "create" || op.kind === "copy" || op.kind === "touch") into.add(CREATED_PATH + unquote(op.target));
  }
  const dbUrl = stage.match(/^(?:export\s+)?DATABASE_URL=["']?([a-z]+:\/\/[^\s"';&|]+)["']?$/);
  if (dbUrl) {
    if (isLocalPrismaDeploy(`DATABASE_URL=${dbUrl[1]} prisma migrate deploy`)) into.add(LOCAL_DB);
    else into.delete(LOCAL_DB);
  }
  const cd = stage.match(/^cd\s+(.+)$/);
  if (cd) {
    const dir = unquote(cd[1].trim());
    const temp = /^"?\$\(\s*mktemp\b/.test(cd[1].trim()) || isEphemeralPath(dir) || isEphemeralVar(dir, into);
    if (temp) into.add(TEMP_CWD);
    else into.delete(TEMP_CWD);
  }
}

function collectMktempVars(stage: string, into: Set<string>): void {
  const m = stage.match(MKTEMP_ASSIGN_RE);
  if (m) into.add(m[1]);
}

// True when `target` is a reference (`$VAR`, `${VAR}`, optionally with a trailing
// subpath like `$VAR/cache`) to a variable known to hold an mktemp temp dir. A
// subpath that climbs out with `..` could escape the temp tree, so it does NOT
// qualify — that stays a real deletion.
function isEphemeralVar(target: string, vars: Set<string>): boolean {
  if (vars.size === 0) return false;
  const m = target.match(/^\$\{?(\w+)\}?(\/.*)?$/);
  if (!m || !vars.has(m[1])) return false;
  if (m[2] && m[2].split("/").includes("..")) return false;
  return true;
}

// Paths where a write/edit is genuinely dangerous and must stay `review`:
// system directories, credential/secret stores, shell startup files (a
// persistence vector), and OKed's own config (so an agent can't disable its
// guardrails). Everything else — project files, sibling repos, scratch — is
// treated as `warning` (a file write can't act on its own; whatever later
// executes it is classified separately).
function isSensitiveWritePath(filePath: string): boolean {
  if (!filePath) return true; // unknown target → err toward review
  const home = os.homedir();
  // Expand a leading `~` / `$HOME` / `${HOME}` to the real home dir BEFORE
  // resolving. In a shell `echo x > ~/.zshrc` the tilde IS the home dir, but
  // path.resolve treats `~` as a literal segment under cwd, which would miss
  // sensitive home targets (shell rc, ~/.ssh, …) and silently downgrade them.
  const expanded = filePath
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  let resolved: string;
  try {
    resolved = path.resolve(expanded);
  } catch {
    return true;
  }
  const underHome = (rel: string) => {
    const base = path.join(home, rel);
    return resolved === base || resolved.startsWith(base + path.sep);
  };
  // OKed self-config — never let an agent edit its own hook config silently.
  if (resolved === path.join(home, ".claude", "settings.json") ||
      resolved === path.join(home, ".claude", "settings.local.json")) return true;
  // Credential / secret stores.
  for (const d of [".ssh", ".aws", ".gnupg", ".kube", ".docker", path.join(".config", "gcloud")]) {
    if (underHome(d)) return true;
  }
  // Sensitive dotfiles directly in $HOME (creds + shell startup persistence).
  const sensitiveHomeFiles = new Set([
    ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".bash_history", ".zsh_history",
    ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile", ".zshenv", ".zlogin",
  ]);
  if (path.dirname(resolved) === home && sensitiveHomeFiles.has(path.basename(resolved))) return true;
  // System directories.
  if (/^\/(etc|usr|bin|sbin|boot|sys|proc|opt|Library|System)(\/|$)/.test(resolved)) return true;
  if (/^\/private\/etc(\/|$)/.test(resolved)) return true;
  // /var, except the ephemeral temp subtrees.
  if (/^\/var(\/|$)/.test(resolved) && !/^\/var\/(tmp|folders)(\/|$)/.test(resolved)) return true;
  return false;
}

export function classify(
  toolName: string,
  toolInput: Record<string, unknown>
): RiskTier {
  // Check tool-level classification first
  if (SAFE_TOOLS.has(toolName)) return "safe";
  if (SAFE_TOOL_ALIASES.has(toolName.toLowerCase())) return "safe";
  if (HIGH_STAKES_TOOLS.has(toolName)) return "high_stakes";
  if (REVIEW_TOOLS.has(toolName)) return "review";
  if (SAFE_SESSION_TOOLS.has(toolName)) return "safe";
  if (WARNING_SESSION_TOOLS.has(toolName)) return "warning";
  const sessionTier = classifySessionTool(toolName, toolInput);
  if (sessionTier !== null) return sessionTier;

  // File-editing tools: a write/edit can't act on its own — whatever later
  // executes it is classified separately — so it's `warning` (logged, no
  // prompt) everywhere EXCEPT sensitive targets (system dirs, secret stores,
  // shell startup files, OKed's own config), which stay `review`.
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath = toolInput.file_path as string;
    return isSensitiveWritePath(filePath) ? "review" : "warning";
  }

  // Agent tool - safe. Launching a sub-agent is not itself a side effect, and
  // the sub-agent's own tool calls (Bash/Write/Edit/MCP) each fire their own
  // PreToolUse hook and get classified independently. Gating the launch on top
  // of that just double-prompts — once for the spawn, again for every real
  // action the sub-agent takes — so the launch auto-allows.
  if (toolName === "Agent") return "safe";

  // Bash commands need deeper analysis
  if (toolName === "Bash") {
    return classifyBashCommand(toolInput.command as string);
  }

  // MCP tools: mcp__<server>__<tool>
  if (toolName.startsWith("mcp__")) {
    return classifyMcpTool(toolName, toolInput);
  }

  // Shell-exec-style tools from other agents (Codex CLI's `exec`, OpenClaw,
  // generic `run`/`run_command`/`shell`). Detect by signature: a string
  // command/cmd field. Route through bash classification.
  const shellCommand = (toolInput.command ?? toolInput.cmd) as unknown;
  if (typeof shellCommand === "string") {
    return classifyBashCommand(shellCommand);
  }

  // File-write-style tools from other agents (OpenClaw `write`, generic
  // `create_file`, `file_write`). Detect by signature: string path field
  // alongside string content/data field. Treat like Write.
  const writePath = (toolInput.file_path ?? toolInput.path) as unknown;
  const writeContent = (toolInput.content ?? toolInput.data ?? toolInput.body) as unknown;
  if (typeof writePath === "string" && typeof writeContent === "string") {
    return isSensitiveWritePath(writePath) ? "review" : "warning";
  }

  // Unknown tool - default to review (require approval)
  return "review";
}

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

/** Split a shell command into top-level segments on the operators that
 * sequence separate commands: `|`, `||`, `&&`, `;`, and a bare newline (a
 * newline separates commands in a multi-line script exactly like `;`).
 * Operators inside quoted strings, command substitutions, and heredoc bodies —
 * including the `"$(cat <<'EOF' … )"` heredoc form used for commit messages —
 * are kept intact so message text isn't split. A backslash-escaped newline is a
 * line continuation, not a separator. Returns trimmed, non-empty segments.
 * With `pipes: false`, a pipeline (`a | b`) stays one segment: the card text
 * reads a pipeline as one step (`printf … | himalaya message send`). */
export function splitTopLevel(cmd: string, opts: { pipes?: boolean } = {}): string[] {
  const splitPipes = opts.pipes !== false;
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let subDepth = 0; // depth inside $( ... ) / `...` command substitutions
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote) {
      // In double quotes a backslash escapes the next char (`"a\"b\|c"` is one
      // string). Single quotes have no escapes.
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
        cur += ch + cmd[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    // Outside quotes a backslash makes the next char literal: `\|`, `\;` and
    // `\"` are not operators or quotes. `\` + newline stays a line continuation.
    if (ch === "\\" && i + 1 < cmd.length && subDepth === 0) {
      cur += ch + cmd[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      cur += ch;
      quote = ch;
      i++;
      continue;
    }
    // Command substitution: keep `$( ... )` / backticks intact so a pipe or `;`
    // inside (e.g. `V=$(curl … | sed …)`) isn't treated as a top-level operator.
    if (ch === "$" && cmd[i + 1] === "(") { subDepth++; cur += "$("; i += 2; continue; }
    if (subDepth > 0 && ch === "(") { subDepth++; cur += ch; i++; continue; }
    if (subDepth > 0 && ch === ")") { subDepth--; cur += ch; i++; continue; }
    if (subDepth > 0) { cur += ch; i++; continue; }
    // Heredoc: consume the opener and the entire body (up to the closing
    // delimiter line) as part of the current segment, so operators inside a
    // heredoc fed to an interpreter (psql/node/…) aren't treated as separators.
    const hd = cmd.slice(i).match(/^<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (hd) {
      cur += hd[0];
      i += hd[0].length;
      const close = cmd.slice(i).match(new RegExp(`\\n[ \\t]*${hd[2]}\\b`));
      if (close) {
        const end = i + (close.index ?? 0) + close[0].length;
        cur += cmd.slice(i, end);
        i = end;
      } else {
        cur += cmd.slice(i);
        i = cmd.length;
      }
      continue;
    }
    const next = cmd[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      out.push(cur.trim());
      cur = "";
      i += 2; // consume both operator chars
      continue;
    }
    if (ch === ";" || (ch === "|" && splitPipes)) {
      out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    // A bare newline sequences commands like `;`. A backslash immediately before
    // it is a line continuation (the two lines are one command), so keep it.
    if (ch === "\n") {
      if (cmd[i - 1] === "\\") { cur += ch; i++; continue; }
      out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

// rm/rmdir/trash whose every target is an ephemeral temp path (/tmp, %TEMP%,
// …) or a variable bound to one by `mktemp` earlier in the same command
// (`ephemeralVars`, e.g. `EMPTYHOME=$(mktemp -d); rm -rf "$EMPTYHOME"`).
// Deleting throwaway temp files is low-risk, so it downgrades to warning. Any
// non-temp target (or deleting a temp ROOT like `/tmp` itself, which isn't an
// ephemeral *path*) means this returns false and the deletion stays high_stakes.
function isEphemeralOnlyDeletion(command: string, ephemeralVars: Set<string> = new Set()): boolean {
  const m = command.match(/^(?:sudo\s+)?(?:rm|rmdir|trash|trash-put)\b\s+(.+)$/s);
  if (!m) return false;
  // A redirect (`2>/dev/null`) is not a target.
  const targets = splitArgs(m[1]).filter((a) => !a.startsWith("-") && !/^(?:\d|&)?>>?\S+$/.test(a));
  if (targets.length === 0) return false;
  return targets.every((a) => {
    const t = unquote(a);
    return isEphemeralPath(t) || isEphemeralVar(t, ephemeralVars) || ephemeralVars.has(CREATED_PATH + t) ||
      (ephemeralVars.has(TEMP_CWD) && /^[\w.-][\w./-]*$/.test(t) && !t.split("/").includes(".."));
  });
}

/**
 * Classifies a single stage that begins with one or more `NAME=value`
 * assignments (a pure assignment like `TARGET=abc`, an env prefix like
 * `FOO=bar cmd`, or a capture like `V=$(cmd)`). Strips the leading assignments,
 * then takes the worst tier of: each command-substitution inner found in the
 * values, plus any trailing command. A purely literal assignment is `safe`.
 * Returns null if the stage is not assignment-prefixed.
 */
function classifyAssignmentStage(stage: string): RiskTier | null {
  if (!/^\w+=/.test(stage)) return null;
  const inners: string[] = [];
  let i = 0;
  while (i < stage.length) {
    const m = stage.slice(i).match(/^(\w+)=/);
    if (!m) break; // next token isn't an assignment → it's the command
    i += m[0].length;
    let quote: '"' | "'" | null = null;
    while (i < stage.length) {
      const ch = stage[i];
      if (quote) { if (ch === quote) quote = null; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (ch === "$" && stage[i + 1] === "(") {
        let d = 1, j = i + 2;
        while (j < stage.length && d > 0) { if (stage[j] === "(") d++; else if (stage[j] === ")") d--; j++; }
        inners.push(stage.slice(i + 2, j - 1));
        i = j;
        continue;
      }
      if (ch === "`") {
        let j = i + 1;
        while (j < stage.length && stage[j] !== "`") j++;
        inners.push(stage.slice(i + 1, j));
        i = j + 1;
        continue;
      }
      if (/\s/.test(ch)) break; // end of this value
      i++;
    }
    while (i < stage.length && /\s/.test(stage[i])) i++;
  }
  const rest = stage.slice(i).trim();
  let tier: RiskTier = "safe";
  for (const inner of inners) tier = maxTier(tier, classifyBashCommand(inner));
  if (rest) tier = maxTier(tier, classifyBashCommand(rest));
  return tier;
}

/**
 * `env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]` runs COMMAND with a
 * modified environment (a wrapper like sudo / an assignment prefix). Strips
 * env's own options (`-i`, `-u NAME`, `-C dir`, `-`, `--unset=NAME`, …) and any
 * leading NAME=VALUE pairs, then classifies the inner COMMAND from its original
 * (quote-preserving) offset. `env` with no command just prints the environment
 * → safe. Returns null if the stage doesn't start with `env`.
 */
function classifyEnvStage(stage: string): RiskTier | null {
  const lead = /^env\b[ \t]*/.exec(stage);
  if (!lead) return null;
  // env options that consume a following argument token.
  const argTaking = new Set(["-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"]);
  const readToken = (from: number): number => {
    let i = from;
    let quote: '"' | "'" | null = null;
    while (i < stage.length) {
      const ch = stage[i];
      if (quote) { if (ch === quote) quote = null; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (/\s/.test(ch)) break;
      i++;
    }
    return i;
  };
  let i = lead[0].length;
  while (i < stage.length) {
    while (i < stage.length && /\s/.test(stage[i])) i++;
    if (i >= stage.length) break;
    const start = i;
    i = readToken(i);
    const tok = stage.slice(start, i);
    if (tok === "-") continue;                                  // ignore-environment marker
    if (tok.startsWith("--") && tok.includes("=")) continue;    // --unset=NAME etc.
    if (tok.startsWith("-")) {
      if (argTaking.has(tok)) {                                 // consume its argument token
        while (i < stage.length && /\s/.test(stage[i])) i++;
        i = readToken(i);
      }
      continue;
    }
    if (/^\w+=/.test(tok)) continue;                            // NAME=VALUE
    return classifyBashCommand(stage.slice(start).trim());      // first real word → the command
  }
  return "safe"; // `env` / `env -u X` with no command just prints the environment
}

// ssh options that consume a following argument token (the rest are flags).
const SSH_ARG_OPTS = new Set([
  "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m",
  "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

/**
 * `ssh [opts] [user@]host [remote command]` — ssh is a transport, so the tier
 * comes from the REMOTE command, classified by the same effect rules as a local
 * one (`ssh host ls` → safe; `ssh host 'rm -rf /data'` → high_stakes). An ssh
 * with no command opens an interactive shell, and port/dynamic forwarding
 * (`-L`/`-R`/`-D`/`-W`) grants opaque access — neither is inspectable, so both
 * get a `review` floor (one prompt for remote access). Returns null if the stage
 * isn't an ssh invocation. Excludes `ssh-keygen`/`ssh-add`/`ssh-keyscan` (the
 * `^ssh\s` anchor requires whitespace, not a hyphen).
 */
function classifySshStage(stage: string): RiskTier | null {
  const lead = /^ssh\s+/.exec(stage);
  if (!lead) return null;
  const readToken = (from: number): number => {
    let i = from;
    let quote: '"' | "'" | null = null;
    while (i < stage.length) {
      const ch = stage[i];
      if (quote) { if (ch === quote) quote = null; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (/\s/.test(ch)) break;
      i++;
    }
    return i;
  };
  let i = lead[0].length;
  let sawForward = false;
  while (i < stage.length) {
    while (i < stage.length && /\s/.test(stage[i])) i++;
    if (i >= stage.length) break;
    const start = i;
    i = readToken(i);
    const tok = stage.slice(start, i);
    if (tok.startsWith("-")) {
      if (/^-[LRDW]/.test(tok)) sawForward = true;       // forwarding/tunnel
      if (SSH_ARG_OPTS.has(tok)) {                        // separated option arg
        while (i < stage.length && /\s/.test(stage[i])) i++;
        i = readToken(i);
      }
      continue;
    }
    // First non-option token is the [user@]host. Everything after it is the
    // remote command (usually a single quoted string).
    if (sawForward) return "review";
    let rest = stage.slice(i).trim();
    if (!rest) return "review";                           // interactive shell
    // Strip one wrapping quote layer so the remote command's own operators
    // (`;`, `|`) are classified as command separators, not quoted data.
    if (rest.length >= 2 && (rest[0] === '"' || rest[0] === "'") && rest[rest.length - 1] === rest[0]) {
      rest = rest.slice(1, -1);
    }
    return classifyBashCommand(rest);
  }
  return "review"; // only options / a bare host token → treat as remote access
}

/**
 * `sh -c '<shell>'` / `bash -c "<shell>"` (also zsh/ksh/dash, and combined flags
 * like `-lc`) runs the quoted argument AS shell. Recurse on the body so its
 * effect is classified by the same rules — mirrors classifySshStage. Only fires
 * when the shell IS the stage's command; a `-c` flag on another tool (e.g.
 * `grep -c`) is unaffected because the stage doesn't start with a shell name.
 * Returns null if the stage isn't a `sh -c`-style invocation.
 */
function classifyShellCStage(stage: string): RiskTier | null {
  const m = stage.match(
    /^(?:bash|sh|zsh|ksh|dash)\b[^'"]*?\s-[A-Za-z]*c\s+(['"])([\s\S]*?)\1/,
  );
  if (!m) return null;
  return classifyBashCommand(m[2]);
}

// A curl/wget whose target host is loopback (localhost, 127.0.0.0/8, 0.0.0.0,
// ::1). A request to a server on this machine is a LOCAL action, not an outward
// one, so a mutating method/body (POST/PUT/DELETE, -d, …) to it doesn't warrant
// a prompt — it downgrades to `warning`. (Download-and-execute, `curl … | sh`,
// is matched earlier on the FULL command and stays high_stakes regardless of
// host, so this only affects the request-method/body patterns.)
function isLoopbackAuthority(authority: string): boolean {
  const host = authority.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return host === "localhost" || host === "0.0.0.0" || host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isLoopbackHttpStage(stage: string): boolean {
  if (!/\b(?:curl|wget)\b/.test(stage)) return false;
  const schemed = [
    ...stage.matchAll(/\bhttps?:\/\/(?:[^@/\s'"]*@)?(\[[0-9A-Fa-f:]+\]|[^/:\s'"]+)/g),
  ].map((m) => m[1]);
  // Every explicit http(s) target must be loopback; a single external URL means
  // the request reaches the network and stays high_stakes.
  if (schemed.length > 0) return schemed.every(isLoopbackAuthority);
  // No scheme'd URL: curl also accepts a scheme-less target (`curl localhost:3999/x`).
  // Accept a loopback host token only when no other http(s) URL is present.
  if (/\bhttps?:\/\//i.test(stage)) return false;
  return /(?:^|[\s@])(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/\s'"]|$)/i.test(stage);
}

function classifyBashCommand(command: string, ephemeralVars: Set<string> = new Set()): RiskTier {
  if (!command) return "safe";

  // Two views of the command:
  //  - `intact`  : heredoc bodies stripped only. Used for SQL detection, so SQL
  //                written inline in an interpreter one-liner (`node -e`,
  //                `python -c`) or a DB CLI is still classified (PR #19).
  //  - `stripped`: ALSO blanks inline-interpreter script bodies. Used for every
  //                SHELL-pattern scan, so a shell token embedded as code/data in
  //                an interpreter body (`rm`, `curl -d`, a `>` redirect — e.g. a
  //                reddit post fed to `node -e '…samples…'`) does not trip a
  //                destructive/outward rule. Quoted curl request bodies (`-d
  //                '{"command":"git push --force"}'`) are blanked the same way. (SQL keywords in that data can still
  //                surface via `intact` — that is the accepted shell-only-opacity
  //                trade-off; see classifyStageShellEffects.)
  const intact = stripHeredocBodies(command).trim();
  const stripped = blankTextCommandArgs(stripCurlDataBodies(stripInlineScriptBodies(stripCodeHeredocBodies(intact)))).trim();

  // High-stakes scan on the FULL (body-stripped) command, before any splitting.
  // These patterns use \b and several intentionally span an operator (e.g.
  // `curl … | bash`, `wget … | sh` — download-and-execute), so they have to be
  // matched against the whole string. Most-restrictive-wins: a high-stakes match
  // anywhere in a compound command takes the whole command to high_stakes. (File
  // deletion is NOT here — it's per-stage below so the ephemeral-temp downgrade
  // can run.)
  for (const pattern of HIGH_STAKES_COMMANDS) {
    if (pattern === NPX_DEPLOY_RE && (isLocalPrismaDeploy(stripped) ||
      (ephemeralVars.has(LOCAL_DB) && /\bprisma\s+migrate\s+deploy\b/.test(stripped)))) continue;
    if (pattern.test(stripped)) return "high_stakes";
  }

  // Text piped into a shell (`echo '…' | sh`, `printf … | bash`) runs as code
  // that no stage shows on its own. At least `review`; a known high-stakes
  // pattern above (curl | sh) already returned.
  const pipesToShell = splitTopLevel(stripped, { pipes: false }).some((step) => {
    const parts = splitTopLevel(step);
    return parts.length > 1 && parts.slice(1).some((p) => /^(?:sudo\s+)?(?:ba|z|k|da)?sh\b(?!\s+-n\b)/.test(p));
  });

  // Compound commands: split on top-level `|`, `||`, `&&`, `;` and take the
  // highest tier. Split the body-INTACT view so each stage keeps its SQL
  // visible; recursion re-derives both views per stage. (Blanking a script body
  // never changes top-level operator structure — operators inside the quoted
  // body aren't split points either way — so stage boundaries are identical.)
  const stages = splitTopLevel(intact);
  if (stages.length > 1) {
    // Gather temp-dir variables (`VAR=$(mktemp -d)`) declared anywhere in this
    // compound command BEFORE classifying any stage, so a later `rm -rf "$VAR"`
    // stage recognizes its target as throwaway even though the binding lives in
    // an earlier stage. Inherits any vars passed from an enclosing command.
    const vars = new Set(ephemeralVars);
    for (const stage of stages) collectMktempVars(stage, vars);
    // Throwaway paths that only EARLIER stages make known: a file an earlier
    // stage created (`cat > _smoke.mjs <<EOF … ; rm _smoke.mjs`), a variable set
    // to a literal temp path (`W=/tmp/wt; rm -rf $W`), and a `cd` into a temp
    // dir (relative paths then live in it). Gathered in order, so a delete
    // before the create still counts as a real delete.
    let worst: RiskTier = pipesToShell ? "review" : "safe";
    for (const stage of stages) {
      worst = maxTier(worst, classifyBashCommand(stage, vars));
      noteEphemeralEffects(stripHeredocBodies(stage), vars);
    }
    return worst;
  }

  // ---- single stage from here ----

  // SQL severity from the body-INTACT view: an interpreter wrapper (python -c,
  // node -e, heredoc), a DB CLI (psql -c, sqlite3 db "...", mysql -e), or SQL at
  // the top of the command. Folded in as a floor so it survives even when the
  // shell pass short-circuits to `safe` (e.g. an assignment-prefixed node -e).
  const sql = findSqlInCommand(intact);
  const sqlTier: RiskTier = sql ? classifySqlSeverity(sql) : "safe";

  return maxTier(maxTier(sqlTier, pipesToShell ? "review" : "safe"), classifyStageShellEffects(stripped, ephemeralVars));
}

/**
 * Shell-effect classification of a SINGLE, already-body-stripped stage. No SQL
 * detection here — that runs on the body-intact view in classifyBashCommand and
 * is folded in by the caller. Returns the stage's tier (default `safe`).
 */
function classifyStageShellEffects(stage: string, ephemeralVars: Set<string> = new Set()): RiskTier {
  // File deletion in COMMAND POSITION, per-stage so the ephemeral-temp carve-out
  // can win: deleting only throwaway temp files (/tmp, $TMPDIR, /var/folders, …)
  // → warning; any non-temp target (or the temp root itself) → high_stakes.
  // A delete word sitting in an argument (filename, branch name, echo text) is
  // NOT a deletion — that's the false positive DELETE_COMMAND_RE avoids.
  if (isEphemeralOnlyDeletion(stage, ephemeralVars)) return "warning";
  // rmdir removes only EMPTY folders (it fails on a folder with files), so no
  // data is lost and `mkdir` undoes it: a reversible local change.
  const deleteStage = stage.replace(DELETE_LEAD, "");
  const rmdirArgs = deleteStage.match(/^(?:sudo\s+)?rmdir\b(.*)$/s)?.[1];
  if (rmdirArgs !== undefined && !DELETE_COMMAND_RE.test(rmdirArgs)) return "warning";
  if (DELETE_COMMAND_RE.test(deleteStage)) return "high_stakes";

  // Destructive/irreversible single commands, matched at stage start with any
  // leading `sudo ` stripped (so `sudo mkfs …` is still caught, but the word
  // can't fire inside an argument). These don't span pipes, so `^`-anchoring is
  // precise and avoids prose false-positives.
  const bareStage = stage.replace(/^sudo\s+/, "");
  // Stopping a process whose command line names a temp or scratchpad path (a
  // test database or server the session started there) is local cleanup.
  if (/^pkill\s+(?:-\w+\s+)*-f\s+/.test(bareStage)) {
    const pattern = unquote(splitArgs(bareStage.replace(/^pkill\s+(?:-\w+\s+)*-f\s+/, ""))[0] ?? "");
    if (/(?:^|\/)scratchpad\//.test(pattern) || EPHEMERAL_PATH_RE.test(pattern)) return "warning";
  }
  // Stopping a local dev server is review: it asks, without Face ID.
  if (isDevServerKill(bareStage)) return "review";
  for (const pattern of HIGH_STAKES_STAGE) {
    if (pattern.test(bareStage)) return "high_stakes";
  }

  // curl with a mutating method or request body → high_stakes. Scanned per-stage
  // (not on the full compound command) so the greedy `.*` can't reach across a
  // `&&`/`|` and match a `-d`/`-T`/etc. flag belonging to a different command.
  // A request to a LOOPBACK host (localhost/127.x/::1) is a local action, not an
  // outward one, so it downgrades to `warning` (logged, no prompt).
  for (const pattern of HIGH_STAKES_CURL_STAGE) {
    if (pattern.test(stage)) {
      return isLoopbackHttpStage(stage) ? "warning" : "high_stakes";
    }
  }

  // `DATABASE_URL=<local> npx prisma migrate deploy`: the assignment prefix
  // below would classify the bare `npx … deploy` without its local URL.
  if (/^(?:\w+=\S+\s+)*npx\s+prisma\s+migrate\s+deploy\b/.test(bareStage) && isLocalPrismaDeploy(bareStage)) return "warning";

  const ghApiTier = classifyGhApiStage(bareStage);
  if (ghApiTier !== null) return ghApiTier;

  // Variable assignments: `NAME=value` (pure) or `NAME=$(cmd) rest` (env prefix
  // / capture). Classify the command-substitution inners and any trailing
  // command; a purely literal assignment is safe. Dangerous substitutions were
  // already caught by the high-stakes/delete scans above.
  const assignTier = classifyAssignmentStage(stage);
  if (assignTier !== null) return assignTier;

  // `env [opts] [NAME=VAL]... cmd` runs cmd with a modified environment. Strip
  // the env prefix and classify the inner command (a dangerous inner was already
  // caught by the high-stakes full scan). Bare `env` just prints the env → safe.
  const envTier = classifyEnvStage(stage);
  if (envTier !== null) return envTier;

  // ssh is a transport — classify the remote command it runs (interactive /
  // port-forwarding ssh has no inspectable command → review floor). scp/rsync
  // to a remote are file transfers and stay high_stakes (HIGH_STAKES_STAGE).
  const sshTier = classifySshStage(stage);
  if (sshTier !== null) return sshTier;

  // `sh -c '<shell>'` / `bash -c "<shell>"` runs the quoted argument AS shell —
  // recurse so its effect is classified by the same rules (mirrors ssh). This
  // is why the command-position delete scan above can ignore quoted text: a real
  // shell-out like `bash -c 'rm -rf /important'` is caught HERE, by re-running
  // the body as a command, while `echo 'rm …'` (data) is not.
  const shellCTier = classifyShellCStage(stage);
  if (shellCTier !== null) return shellCTier;

  // sudo: privilege escalation. A high-stakes inner command was already caught
  // by the full-string scan above (\b patterns match through the `sudo` prefix);
  // anything else still warrants review.
  if (/^sudo\s/.test(stage)) return "review";

  // File-mutating shell patterns (echo > X, tee, dd of=, touch, sed -i, cp, mv).
  // A file write/copy/move is a reversible LOCAL mutation, classified like the
  // Write/Edit tool: `warning` (logged) — UNLESS a target is a sensitive path
  // (system dir, secret store, shell rc, OKed config), which stays `review`.
  // (Overwriting a raw block device was already caught by the high-stakes scan.)
  const ops = extractShellWriteOps(stage);
  if (ops.length > 0) {
    const targets = ops.map((o) => o.target);
    return targets.some((t) => isSensitiveWritePath(t)) ? "review" : "warning";
  }

  // Outward sends (email/message) → review.
  for (const pattern of REVIEW_COMMANDS) {
    if (pattern.test(stage)) return "review";
  }

  // Local-mutation markers (local git, code execution, installs) → warning:
  // logged, no prompt. Everything else is a read or an unrecognized command with
  // no detected effect — and under the effect-based model that means `safe`.
  for (const pattern of WARNING_COMMANDS) {
    if (pattern.test(stage)) return "warning";
  }

  // Default: safe. No destructive/outward/sensitive effect was detected, so we
  // do NOT put a human in the loop just for "running a command".
  return "safe";
}

function classifySqlSeverity(sql: string): RiskTier {
  if (/\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\b/i.test(sql)) return "high_stakes";
  if (/\bTRUNCATE\b/i.test(sql)) return "high_stakes";
  if (/\bDELETE\s+FROM\b/i.test(sql)) return "high_stakes";
  if (/\bUPDATE\s+\w+\s+SET\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) return "high_stakes";
  if (/\bCREATE\s+(TABLE|INDEX|VIEW)\b/i.test(sql)) return "warning";
  if (/^\s*SELECT\b/i.test(sql)) return "safe";
  if (/^\s*(EXPLAIN|SHOW|DESCRIBE|DESC)\b/i.test(sql)) return "safe";
  // SQLite dot-commands (.tables, .schema, .dump, etc.) — safe unless they mutate
  if (/^\s*\./.test(sql) && !/^\s*\.(import|read|restore)\b/i.test(sql)) return "safe";
  // INSERT/ALTER and other non-destructive DML: a reversible row/schema change,
  // not a data wipe → warning (logged, no prompt). Destructive SQL (DROP /
  // TRUNCATE / DELETE FROM / UPDATE-without-WHERE) returned high_stakes above.
  return "warning";
}

export type ShellWriteKind = "create" | "append" | "edit" | "touch" | "copy" | "move";

export interface ShellWriteOp {
  kind: ShellWriteKind;
  target: string;
  source?: string; // for copy/move
  content?: string; // literal content for echo/printf when extractable
}

/**
 * Detects shell idioms that mutate the filesystem. Used by classify (to
 * choose tier) and describe (to render the operation as a Create/Append/
 * Copy/etc. sentence rather than as a shell command).
 *
 * Skips /dev/null and bare-digit FD duplicates (2>&1).
 */
// Commands that EXECUTE a heredoc body fed to their stdin — a SQL CLI, a code
// interpreter, or a shell. Their heredoc bodies are code/SQL and must stay
// scannable. Detected as a command word at the start of the opener line or
// after a pipe / `&&` / `;` / `$(` / backtick.
const HEREDOC_INTERPRETER_RE =
  /(?:^|\||&&|;|\$\(|`)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|mariadb|sqlite3?|node|python\d?|ruby|perl|deno|bun|bash|sh|zsh|ksh|fish)\b/;

// Only the step that holds the heredoc reads its body. An interpreter in an
// earlier step on the same line (`V=$(node -p '…'); cat > f <<'EOF'`) does not.
// splitTopLevel keeps the opener and the rest of the line in the last step, so
// a pipe after the opener (`cat <<EOF | bash`) still counts.
function openerFeedsInterpreter(line: string): boolean {
  const steps = splitTopLevel(line, { pipes: false });
  return HEREDOC_INTERPRETER_RE.test(steps[steps.length - 1] ?? line);
}

/**
 * Removes heredoc *bodies* unless they're fed to an interpreter/DB/shell that
 * executes them. The default is to strip: `cat >> file <<'EOF'`, `git commit -F
 * - <<'MSG'`, `gh pr create --body "$(cat <<'BODY')"`, `mail <<'EOF'` and the
 * like all treat the body as literal DATA, which must not be parsed as shell
 * (a commit message with `->` or a PR body mentioning "TRUNCATE"/"rm -rf" would
 * otherwise wreck classification). Only heredocs whose opener line invokes an
 * interpreter (`psql <<EOF`, `node - <<EOF`, `cat <<EOF | bash`) keep their
 * body, so SQL/code detection still runs. The opener line is always preserved.
 * The closing delimiter line is kept too: without it, splitTopLevel cannot see
 * where the heredoc ends and joins every later step (`; rm -rf …`) into the
 * heredoc's step, where a delete or merge after `;` is not seen.
 */
export function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    // Heredoc openers: <<DELIM, <<'DELIM', <<"DELIM", <<-DELIM (with optional
    // space). Require a word-char delimiter so numeric left-shifts ($((1<<2)))
    // don't match. Use the last opener on the line as the active delimiter.
    const openers = [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)];
    if (openers.length > 0 && !openerFeedsInterpreter(line)) {
      const delim = openers[openers.length - 1][2];
      i++;
      while (i < lines.length && lines[i].trim() !== delim) i++; // drop body
      if (i < lines.length) out.push(lines[i++]); // keep the closing delimiter line
      continue;
    }
    i++;
  }
  return out.join("\n");
}

// Interpreters (not shells) whose heredoc body is code: `python3 - <<'EOF'`,
// `node - <<EOF`, `psql <<SQL`. Shell heredocs (`bash <<EOF`) stay scannable.
const CODE_HEREDOC_RE =
  /(?:^|\||&&|;|\$\(|`)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|mariadb|sqlite3?|node|python\d?(?:\.\d+)?|ruby|perl|deno|bun)\b[^\n|;&]*<</;

/**
 * Drop the bodies of heredocs fed to a code interpreter, for the SHELL-pattern
 * scans only (the same policy as `-e`/`-c` bodies below). A Python script that
 * edits a file whose text says "git push --force" or "npm publish" is not a
 * force push or a publish. SQL detection still reads the intact body.
 * `dropClose` also drops the closing delimiter line, for card text only.
 */
export function stripCodeHeredocBodies(command: string, opts: { dropClose?: boolean } = {}): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    const openers = [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)];
    if (openers.length > 0 && CODE_HEREDOC_RE.test(line)) {
      const delim = openers[openers.length - 1][2];
      i++;
      while (i < lines.length && lines[i].trim() !== delim) i++;
      if (i < lines.length) {
        if (!opts.dropClose) out.push(lines[i]); // keep the closing line (see stripHeredocBodies)
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("\n");
}

// Commands whose quoted arguments are text, never run: a commit message, a
// search pattern, a PR body, printed text. `gh api` is left out: its fields are
// a request payload (a GraphQL mutation, for example).
const TEXT_ARG_COMMAND_RE = /^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:git|grep|egrep|fgrep|rg|echo|printf|gh(?!\s+api\b))\b/;

// A script file run by node/tsx/bun (`node scripts/x.mjs …`), not inline code
// (`node -e`). Its quoted long-option values (`--reason "…"`) are text. Its
// quoted positional arguments keep their text, because the script may run them.
const SCRIPT_FILE_STEP_RE =
  /^(?:\\\s+)?(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:node|tsx|bun)\s+(?!-)\S+\.[cm]?[jt]s(?:\s|$)/;
const LONG_OPTION_QUOTED_VALUE_RE = /(--[\w-]+(?:=|\s+))('[^']*'|"(?:[^"\\]|\\.)*")/g;

// Commands that run the text piped into them as code.
const RUNS_PIPED_TEXT_RE =
  /^(?:sudo\s+)?(?:(?:ba|z|k|da)?sh|xargs|eval|source|\.|node|deno|bun|python\d?(?:\.\d+)?|ruby|perl|psql|mysql|mariadb|sqlite3?)\b/;

/**
 * Blank the inside of quoted arguments of text commands, for the SHELL-pattern
 * scans only, so `git commit -m "curl -d sends JSON"` or `grep "curl -X POST"`
 * is not read as a POST. A step that pipes into a command that runs its input
 * (`echo '…' | sh`) keeps its text. A pipe into a reader (`grep "…" | head`)
 * does not run the text, so the text is blanked.
 */
export function blankTextCommandArgs(command: string): string {
  return splitTopLevel(command, { pipes: false })
    .map((step) => {
      if (SCRIPT_FILE_STEP_RE.test(step)) {
        if (splitTopLevel(step).slice(1).some((p) => RUNS_PIPED_TEXT_RE.test(p))) return step;
        return step.replace(LONG_OPTION_QUOTED_VALUE_RE, (_m, opt: string, q: string) =>
          opt + q[0] + " ".repeat(Math.max(0, q.length - 2)) + q[0]);
      }
      if (!TEXT_ARG_COMMAND_RE.test(step)) return step;
      if (splitTopLevel(step).slice(1).some((p) => RUNS_PIPED_TEXT_RE.test(p))) return step;
      // A quoted redirect target (`>> "$HOME/.ssh/authorized_keys"`) is a path, not text.
      return step.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q, at: number) =>
        /[<>]\s*$/.test(step.slice(0, at)) ? q : q[0] + " ".repeat(Math.max(0, q.length - 2)) + q[0]);
    })
    .join("\n");
}

// Interpreters whose inline `-e`/`-c`/`--eval` (and perl/deno one-liner) body is
// opaque CODE — not shell. We blank that body before the SHELL-pattern scans so
// tokens embedded as code or data (`rm`, `curl -d`, a `>` redirect) don't trip a
// destructive/outward rule. This matches the documented policy that opaque code
// execution is `safe` (see the WARNING_COMMANDS note): we can't tell what a
// `node -e`/`python -c` body does, and a real destructive shell effect buried
// inside it would slip through the label regardless — so scanning the body for
// shell tokens only manufactures false positives.
//
// NOTE: SQL is the deliberate exception. classifyBashCommand still runs SQL
// detection on the body-INTACT view, so inline SQL in a `node -e`/`python -c`
// one-liner stays classified (PR #19). The trade-off ("shell-only opacity"): a
// SQL keyword sitting in DATA passed to an interpreter can still surface.
//
// Deliberately EXCLUDED from stripping: shell interpreters (`sh -c`, `bash -c`)
// whose body IS shell — those bodies must stay scannable. The matcher requires a
// quoted body, so an unquoted `node -e expr` (which can't carry spaces/operators)
// is left untouched.
const INLINE_SCRIPT_RE =
  /\b(?:node|deno|bun|python[23]?|ruby|perl)\b[^\n|;&'"]*?\s(?:eval|--eval|--print|-e|-c|-p|-ne|-pe|-ple|-ane|-nae)\b\s*(['"])/g;

export function stripInlineScriptBodies(command: string): string {
  INLINE_SCRIPT_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_SCRIPT_RE.exec(command)) !== null) {
    const quote = m[1];
    const bodyStart = m.index + m[0].length; // index just past the opening quote
    let j = bodyStart;
    if (quote === "'") {
      // Single quotes: no escaping in shell — body runs to the next single quote.
      while (j < command.length && command[j] !== "'") j++;
    } else {
      // Double quotes: a backslash escapes the next char.
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
    }
    out += command.slice(last, bodyStart); // prefix through the opening quote
    out += quote;                           // closing quote — interior blanked
    last = j < command.length ? j + 1 : command.length;
    INLINE_SCRIPT_RE.lastIndex = last;      // resume after the closing quote
  }
  out += command.slice(last);
  return out;
}

// curl request-body flags whose quoted value is payload sent to a server,
// never run locally.
const CURL_DATA_FLAG_RE = /^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form)(?:\s+|=)(['"])/;

/**
 * Blank the interior of quoted curl request bodies, keeping the quotes and the
 * flag so the per-stage curl rules still see a POST. A JSON payload that
 * mentions `git push --force` or `rm -rf` is data, and must not trip the
 * full-command high-stakes scan. Only applies inside a curl stage (from `curl`
 * to the next unquoted `;`, `|`, `&` or newline).
 */
export function stripCurlDataBodies(command: string): string {
  let out = "";
  let inCurl = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      // Copy a quoted span verbatim (it isn't a body we're blanking).
      let j = i + 1;
      while (j < command.length && command[j] !== ch) {
        if (ch === '"' && command[j] === "\\") j++;
        j++;
      }
      out += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[;|&\n]/.test(ch)) inCurl = false;
    else if (!inCurl && /^curl\b/.test(command.slice(i)) && (i === 0 || /[\s(;|&]/.test(command[i - 1]))) {
      inCurl = true;
    } else if (inCurl && /\s/.test(ch)) {
      const m = command.slice(i + 1).match(CURL_DATA_FLAG_RE);
      if (m) {
        const quote = m[1];
        const bodyStart = i + 1 + m[0].length;
        let j = bodyStart;
        while (j < command.length && command[j] !== quote) {
          if (quote === '"' && command[j] === "\\") j++;
          j++;
        }
        out += command.slice(i, bodyStart) + quote;
        i = j + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Find output redirects (`>`, `>>`, `&>`, `2>`, …) outside quoted strings.
 * The target token may itself be quoted. Skips `2>&1`-style FD dups, bare
 * digits, and /dev/null. Heredoc `<<` is ignored (only `>` is a write). */
function findRedirects(cmd: string): { append: boolean; target: string }[] {
  const res: { append: boolean; target: string }[] = [];
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    const op = cmd.slice(i).match(/^([12]?>>?|&>>?)/);
    if (op && cmd[i - 1] !== ">") {
      let j = i + op[1].length;
      while (j < cmd.length && /\s/.test(cmd[j])) j++;
      let target = "";
      if (cmd[j] === '"' || cmd[j] === "'") {
        const q = cmd[j];
        j++;
        while (j < cmd.length && cmd[j] !== q) target += cmd[j++];
        if (j < cmd.length) j++; // closing quote
      } else {
        while (j < cmd.length && !/[\s>|&;]/.test(cmd[j])) target += cmd[j++];
      }
      if (target && !/^\d+$/.test(target) && !isDevNullish(target)) {
        res.push({ append: op[1] === ">>" || op[1] === "&>>", target });
      }
      i = j;
      continue;
    }
    i++;
  }
  return res;
}

export function extractShellWriteOps(command: string): ShellWriteOp[] {
  const cmd = stripHeredocBodies(command).trim();
  const ops: ShellWriteOp[] = [];

  // Output redirects: > path, >> path, &> path, 2> path. Quote-aware so a `>`
  // inside a quoted argument (e.g. a grep pattern `"echo > x"`) isn't mistaken
  // for a redirect. The target token itself may be quoted (`> "my file"`).
  for (const r of findRedirects(cmd)) {
    const content = extractEchoContent(cmd);
    ops.push({ kind: r.append ? "append" : "create", target: r.target, content });
  }

  // tee [-a] path
  const teeM = cmd.match(/\btee\b\s+(-[aA]\s+)?([^\s|;&]+)/);
  if (teeM) {
    const target = unquote(teeM[2]);
    if (target && !isDevNullish(target) && !target.startsWith("-")) {
      ops.push({ kind: teeM[1] ? "append" : "create", target });
    }
  }

  // cp src dest
  const cpM = cmd.match(/^\s*cp\b\s+(.+)$/);
  if (cpM) {
    const args = splitArgs(cpM[1]).filter((a) => !a.startsWith("-"));
    if (args.length >= 2) {
      ops.push({ kind: "copy", target: unquote(args[args.length - 1]), source: unquote(args[0]) });
    }
  }

  // mv src dest
  const mvM = cmd.match(/^\s*mv\b\s+(.+)$/);
  if (mvM) {
    const args = splitArgs(mvM[1]).filter((a) => !a.startsWith("-"));
    if (args.length >= 2) {
      ops.push({ kind: "move", target: unquote(args[args.length - 1]), source: unquote(args[0]) });
    }
  }

  // sed -i / --in-place
  if (/\bsed\b/.test(cmd) && (/-i(?:\.\w+)?\b/.test(cmd) || /--in-place\b/.test(cmd))) {
    const sedM = cmd.match(/^\s*sed\b\s+(.+)$/);
    if (sedM) {
      const args = splitArgs(sedM[1]);
      let scriptSeen = false;
      for (const a of args) {
        if (a.startsWith("-")) continue;
        if (!scriptSeen) { scriptSeen = true; continue; }
        ops.push({ kind: "edit", target: unquote(a) });
      }
    }
  }

  // dd of=path
  const ddRe = /\bdd\b[^|;&]*\bof=([^\s|;&]+)/g;
  for (const m of cmd.matchAll(ddRe)) {
    const target = unquote(m[1]);
    if (target && !isDevNullish(target)) ops.push({ kind: "create", target });
  }

  // touch path1 path2...
  const touchM = cmd.match(/^\s*touch\b\s+(.+)$/);
  if (touchM) {
    for (const a of splitArgs(touchM[1])) {
      if (!a.startsWith("-")) ops.push({ kind: "touch", target: unquote(a) });
    }
  }

  return ops;
}

function extractEchoContent(cmd: string): string | undefined {
  // echo [-neE] "content" > path  /  printf "content" > path
  const m = cmd.match(/^\s*(?:echo|printf)\b\s+(?:-[neE]+\s+)?(.+?)\s*(?:[12]?>>?|&>>?)/);
  if (!m) return undefined;
  const raw = m[1].trim();
  if (!raw) return undefined;
  return unquote(raw);
}

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

function isDevNullish(p: string): boolean {
  return p === "/dev/null" || p === "/dev/stdout" || p === "/dev/stderr";
}

function splitArgs(s: string): string[] {
  // Simple whitespace split honoring single/double quoted strings.
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Browser MCP servers: the desktop app's built-in browser pane (also reached
// as mcp__remote-devices__Claude_Browser__* from cloud sessions) and the
// Claude in Chrome extension. Their tool names don't follow the verb-prefix
// convention below, so they get an explicit table keyed on the tool name.
const BROWSER_MCP_SERVERS = new Set(["Claude_Browser", "claude-in-chrome"]);

// Browser tools that only look at, open, or arrange pages (no clicks, typing,
// form fills, script execution, or uploads). Navigation is a read, like
// WebSearch. Anything not listed here falls through to `review`.
const SAFE_BROWSER_TOOLS = new Set([
  "navigate",
  "find",
  "read_page",
  "get_page_text",
  "read_console_messages",
  "read_network_requests",
  "tabs_context",
  "tabs_context_mcp",
  "tabs_create",
  "tabs_create_mcp",
  "tabs_select",
  "tabs_close",
  "tabs_close_mcp",
  "resize_window",
  "preview_list",
  "preview_logs",
  "preview_stop",
  "gif_creator",
  "shortcuts_list",
  "list_connected_browsers",
  "select_browser",
  "switch_browser",
]);

// `computer` actions that only observe or move the viewport.
const SAFE_COMPUTER_ACTIONS = new Set(["screenshot", "zoom", "scroll", "scroll_to", "hover", "wait"]);

// Page interactions (clicks, typing, form fills, in-page JS). In the desktop
// app's built-in browser pane these act in an isolated browser, mostly against
// the user's own dev servers, so they're logged (`warning`) rather than
// prompted: a prompt per click is pure approval fatigue. In Claude in Chrome
// they act inside the user's real logged-in sessions (mail, banking, …), so
// they stay `review`.
const BROWSER_INTERACTION_TOOLS = new Set(["computer", "form_input", "javascript_tool"]);

function classifyBrowserTool(tool: string, toolInput: Record<string, unknown>, server: string): RiskTier {
  if (SAFE_BROWSER_TOOLS.has(tool)) return "safe";
  // preview_start with `url` just opens a tab. With `name` it launches the
  // dev-server command from .claude/launch.json, which is arbitrary command
  // execution, so it stays `review`.
  if (tool === "preview_start") {
    return typeof toolInput.url === "string" && toolInput.name === undefined ? "safe" : "review";
  }
  if (tool === "computer" && SAFE_COMPUTER_ACTIONS.has(toolInput.action as string)) return "safe";
  if (BROWSER_INTERACTION_TOOLS.has(tool)) {
    return server === "claude-in-chrome" ? "review" : "warning";
  }
  // A batch is as risky as its riskiest step.
  if (tool === "browser_batch") {
    const actions = toolInput.actions;
    if (!Array.isArray(actions) || actions.length === 0) return "review";
    let tier: RiskTier = "safe";
    for (const a of actions) {
      const name = (a as { name?: unknown })?.name;
      const input = (a as { input?: unknown })?.input;
      if (typeof name !== "string" || name === "browser_batch") return "review";
      tier = maxTier(tier, classifyBrowserTool(name, (input && typeof input === "object" ? input : {}) as Record<string, unknown>, server));
    }
    return tier;
  }
  return "review";
}

/**
 * Desktop app folder access (`ccd_directory`): change_directory moves the
 * session to a folder, request_directory adds a folder to it. The app already
 * shows its own approval for the exact folder (except in bypass permissions
 * mode), so a second OKed prompt is approval fatigue. Log it (`warning`), but
 * keep `review` for a broad or sensitive grant: the filesystem root, the home
 * folder or one of its parents, secret stores and system folders. Without a
 * path, request_directory opens a native picker the user drives: `safe`.
 */
function classifyDirectoryGrant(tool: string, toolInput: Record<string, unknown>): RiskTier {
  const dir = typeof toolInput.path === "string" ? toolInput.path.trim() : "";
  if (!dir) return tool === "request_directory" ? "safe" : "review";
  const home = os.homedir();
  const resolved = path.resolve(dir.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home));
  const isHomeOrParent = home === resolved || home.startsWith(resolved.endsWith(path.sep) ? resolved : resolved + path.sep);
  if (isHomeOrParent || isSensitiveWritePath(resolved)) return "review";
  return "warning";
}

/**
 * Desktop app (`ccd_*`) tools that only change what the app shows or how it
 * tracks this session: panes, split view, the sidebar, the PR bar, archiving.
 * sync_with_base_branch merges the base branch into the session's worktree on
 * the host, the same as a Bash `git merge` or `git pull` (both safe); a push
 * after it is gated on its own. The app's tools with a real effect stay out
 * of this table: set_auto_merge (GitHub merges the PR), set_setting,
 * permission or model changes, worktree clean-up and discards.
 */
const CCD_SAFE_TOOLS = new Map<string, ReadonlySet<string>>([
  ["ccd_pr", new Set(["bind_pr", "unbind_pr"])],
  ["ccd_view", new Set(["show_pane", "close_pane", "set_transcript_view"])],
  ["ccd_session", new Set(["spawn_task"])],
  // The task list under Claude's message and the end-of-turn summary box.
  ["ccd_turn", new Set(["update_plan", "wrap_up"])],
  ["ccd_window", new Set(["open_session_in", "close_split", "set_sidebar_collapsed"])],
  ["ccd_sidebar", new Set([
    "create_group", "create_section", "rename_group", "rename_section",
    "move_sessions", "set_pinned", "set_unread", "set_view",
  ])],
  ["ccd_host", new Set(["open_in_editor", "reveal_path", "request_keep_awake", "sync_with_base_branch"])],
  ["ccd_session_mgmt", new Set(["set_session_title", "archive_session", "unarchive_session"])],
]);

// claude.ai connectors reach Claude Code as mcp__<uuid>__<tool>, so the server
// name does not say which connector it is.
const CONNECTOR_SERVER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tool names that are a read verb alone (the prefix rules below need "read_").
const SAFE_BARE_TOOLS = new Set(["read", "get", "list", "search", "find", "view", "guide", "help"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Claude Docs connector writes: `batch` (create a doc or apply edits to one)
 * and `update` (edit a tab, rename, change a stored value). They change the
 * user's own docs on claude.ai, which are private until the user shares them.
 * Log them (`warning`), no prompt. The input shape identifies the connector,
 * because its server name is a UUID and the tool names are generic. Sharing
 * and deletes are not in this rule.
 */
function isClaudeDocsWrite(server: string, tool: string, input: Record<string, unknown>): boolean {
  if (!CONNECTOR_SERVER_RE.test(server)) return false;
  if (tool === "batch") {
    return isRecord(input.container) && typeof input.container.kind === "string" &&
      (input.batch === undefined || Array.isArray(input.batch));
  }
  if (tool === "update") {
    return isRecord(input.ref) && typeof input.ref.object === "string" && typeof input.ref.id === "string" &&
      input.payload !== undefined;
  }
  return false;
}

function classifyMcpTool(toolName: string, toolInput: Record<string, unknown> = {}): RiskTier {
  const parts = toolName.split("__");
  const tool = parts[parts.length - 1] || "";

  if (parts.includes("ccd_directory") && (tool === "change_directory" || tool === "request_directory")) {
    return classifyDirectoryGrant(tool, toolInput);
  }
  if (parts.slice(1, -1).some((p) => CCD_SAFE_TOOLS.get(p)?.has(tool))) return "safe";
  // The PR bar's CI monitor switches. auto_fix lets the session push fixes,
  // but each push is gated on its own. Log it, no prompt.
  if (parts.includes("ccd_pr") && tool === "set_monitor") return "warning";
  // Start a new local Claude session, or move this task into one. Its own tool
  // calls are gated by OKed like this one's, so log it, no prompt. A cloud or
  // SSH session runs outside this machine's hook, so it stays `review`.
  if (parts.includes("ccd_session") && (tool === "start_session" || tool === "hand_off_to_session")) {
    const target = toolInput.target;
    return target === undefined || target === "local" ? "warning" : "review";
  }
  if (parts.length === 3 && isClaudeDocsWrite(parts[1] || "", tool, toolInput)) return "warning";

  // The desktop app's iOS Simulator: a local test device. Looking at it is
  // safe; taps, typing and installing a local build change only the
  // simulator, like page clicks in the built-in browser, so they are logged.
  if (parts.includes("Claude_Code_iOS_Simulator")) {
    if (tool === "control") {
      const action = toolInput.action;
      if (action === "screenshot" || action === "attach" || action === "detach") return "safe";
      if (["tap", "swipe", "touch_path", "touch2_path", "text", "button", "open_url", "launch"].includes(action as string)) return "warning";
      return "review";
    }
    if (tool === "build") return "warning";
  }

  const browserServer = parts.slice(1, -1).find((p) => BROWSER_MCP_SERVERS.has(p));
  if (browserServer) return classifyBrowserTool(tool, toolInput, browserServer);

  // Read-only retrieval verbs.
  if (SAFE_BARE_TOOLS.has(tool)) return "safe";
  if (tool.startsWith("list_") || tool.startsWith("get_") || tool.startsWith("search_") ||
      tool.startsWith("read_") || tool.startsWith("fetch_") || tool.startsWith("query_") ||
      tool.startsWith("find_") || tool.startsWith("view_") || tool.startsWith("show_") ||
      tool.startsWith("describe_") || tool.startsWith("inspect_") || tool.startsWith("check_") ||
      tool.startsWith("count_")) {
    return "safe";
  }
  // Annotation / transcript-marker verbs — they label or organize the session
  // (mark a chapter, flag a follow-up, dismiss a chip) without touching the
  // filesystem, network, or any external service, so they auto-allow silently.
  if (tool.startsWith("mark_") || tool.startsWith("annotate_") || tool.startsWith("tag_") ||
      tool.startsWith("label_") || tool.startsWith("dismiss_")) {
    return "safe";
  }
  if (tool.endsWith("_status") || tool.endsWith("_info") || tool.endsWith("_count") ||
      tool.endsWith("_exists") || tool.endsWith("_version") || tool.endsWith("_health")) {
    return "safe";
  }
  if (tool.startsWith("delete_") || tool.startsWith("drop_") || tool.startsWith("remove_")) {
    return "high_stakes";
  }
  if (tool.startsWith("send_") || tool.startsWith("create_") || tool.startsWith("update_")) {
    return "review";
  }

  return "review";
}
