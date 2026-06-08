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

// Tools that are always review-tier risk (modify local files)
const REVIEW_TOOLS = new Set<string>([]);

// Tools that are always high stakes
const HIGH_STAKES_TOOLS = new Set<string>([]);

// NOTE: there is intentionally NO "safe commands" allowlist. Under the
// effect-based model, anything we don't detect as a mutation or a prompt-worthy
// effect IS safe by default (reads, queries, `ls`, `grep`, `jq`, `awk`, `sort`,
// unknown commands, …). We only enumerate the things that DO warrant a log
// (WARNING_*) or a prompt (REVIEW_*, HIGH_STAKES_*).

// File deletion (rm/rmdir/trash). Checked PER-STAGE (not on the full command)
// so the ephemeral-temp downgrade can run first: `something; rm /tmp/x` must be
// warning, but `rm /tmp/x` mixed with a non-temp delete in another stage stays
// high_stakes. Matching the bare word also catches it inside a loop body or a
// $(...) substitution stage.
const DELETE_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\btrash\b/,
  /\btrash-put\b/,
];

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
  /\bcurl\s+.*-X\s*(DELETE|PUT|POST|PATCH)\b/i,
  /\bcurl\s+.*--request\s*(DELETE|PUT|POST|PATCH)\b/i,
  // curl flags that send a request body (POST/PUT/PATCH) without an explicit -X
  /\bcurl\b.*\s-d[\s=]/,
  /\bcurl\b.*\s--data(-raw|-binary|-urlencode|-ascii)?[\s=]/,
  /\bcurl\b.*\s-F[\s=]/,
  /\bcurl\b.*\s--form[\s=]/,
  /\bcurl\b.*\s(-T|--upload-file)[\s=]/,
  /\bcurl\b.*\s--json[\s=]/,
  /\bwget\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bcurl\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bnpm\s+publish\b/,
  /\bnpm\s+unpublish\b/,
  /\bnpx\s+.*\s+deploy\b/,
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
  // Process termination.
  /^kill\b/,
  /^pkill\b/,
  /^killall\b/,
  // Wide-open permissions.
  /^chmod\s+(?:-\S+\s+)*777\b/,
];

// Outward-but-recoverable commands → review (prompt, simple approve). Sending
// mail/messages can't be unsent, but it isn't destructive to local state, so it
// sits below high_stakes. Matched per-stage. (Destructive himalaya verbs —
// message delete, folder purge — are high_stakes in the full scan above.)
const REVIEW_COMMANDS = [
  /^himalaya\s+message\s+(send|reply|forward)\b/,
];

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
    return classifyMcpTool(toolName);
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
 * sequence separate commands: `|`, `||`, `&&`, `;`. Operators inside quoted
 * strings — including the `"$(cat <<'EOF' … )"` heredoc form used for commit
 * messages — are kept intact so message text isn't split. Returns trimmed,
 * non-empty segments. */
function splitTopLevel(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let subDepth = 0; // depth inside $( ... ) / `...` command substitutions
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
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
    if (ch === "|" || ch === ";") {
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
// …). Deleting throwaway temp files is low-risk, so it downgrades to warning.
// Any non-temp target (or deleting a temp ROOT like `/tmp` itself, which isn't
// an ephemeral *path*) means this returns false and the deletion stays
// high_stakes.
function isEphemeralOnlyDeletion(command: string): boolean {
  const m = command.match(/^(?:sudo\s+)?(?:rm|rmdir|trash|trash-put)\b\s+(.+)$/s);
  if (!m) return false;
  const targets = splitArgs(m[1]).filter((a) => !a.startsWith("-"));
  if (targets.length === 0) return false;
  return targets.every((a) => isEphemeralPath(unquote(a)));
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

function classifyBashCommand(command: string): RiskTier {
  if (!command) return "safe";

  // Strip heredoc bodies up front: their contents are literal data, not shell,
  // and must not be scanned for high-stakes tokens, operators, or redirects.
  const trimmed = stripHeredocBodies(command).trim();

  // High-stakes scan on the FULL command, before any splitting. These patterns
  // use \b and several intentionally span an operator (e.g. `curl … | bash`,
  // `wget … | sh` — download-and-execute), so they have to be matched against
  // the whole string. Most-restrictive-wins: a high-stakes match anywhere in a
  // compound command takes the whole command to high_stakes. (File deletion is
  // NOT here — it's per-stage below so the ephemeral-temp downgrade can run.)
  for (const pattern of HIGH_STAKES_COMMANDS) {
    if (pattern.test(trimmed)) return "high_stakes";
  }

  // Compound commands: split on top-level `|`, `||`, `&&`, `;` and take the
  // highest tier. Without this, `cat /tmp/draft.eml | himalaya message send`
  // would match `^cat\b` and silently allow the send, and `git add … && git
  // commit …` couldn't be recognized as the local git ops they are. Only
  // recurse when there are 2+ stages so single commands don't loop.
  const stages = splitTopLevel(trimmed);
  if (stages.length > 1) {
    return stages.reduce<RiskTier>(
      (worst, stage) => maxTier(worst, classifyBashCommand(stage)),
      "safe",
    );
  }

  // ---- single stage from here ----

  // File deletion, per-stage so the ephemeral-temp carve-out can win: deleting
  // only throwaway temp files (/tmp, $TMPDIR, /var/folders, …) → warning; any
  // non-temp target (or the temp root itself) → high_stakes.
  if (isEphemeralOnlyDeletion(trimmed)) return "warning";
  for (const pattern of DELETE_PATTERNS) {
    if (pattern.test(trimmed)) return "high_stakes";
  }

  // Destructive/irreversible single commands, matched at stage start with any
  // leading `sudo ` stripped (so `sudo mkfs …` is still caught, but the word
  // can't fire inside an argument). These don't span pipes, so `^`-anchoring is
  // precise and avoids prose false-positives.
  const bareStage = trimmed.replace(/^sudo\s+/, "");
  for (const pattern of HIGH_STAKES_STAGE) {
    if (pattern.test(bareStage)) return "high_stakes";
  }

  // Variable assignments: `NAME=value` (pure) or `NAME=$(cmd) rest` (env prefix
  // / capture). Classify the command-substitution inners and any trailing
  // command; a purely literal assignment is safe. Dangerous substitutions were
  // already caught by the high-stakes/delete scans above.
  const assignTier = classifyAssignmentStage(trimmed);
  if (assignTier !== null) return assignTier;

  // `env [opts] [NAME=VAL]... cmd` runs cmd with a modified environment. Strip
  // the env prefix and classify the inner command (a dangerous inner was already
  // caught by the high-stakes full scan). Bare `env` just prints the env → safe.
  const envTier = classifyEnvStage(trimmed);
  if (envTier !== null) return envTier;

  // ssh is a transport — classify the remote command it runs (interactive /
  // port-forwarding ssh has no inspectable command → review floor). scp/rsync
  // to a remote are file transfers and stay high_stakes (HIGH_STAKES_STAGE).
  const sshTier = classifySshStage(trimmed);
  if (sshTier !== null) return sshTier;

  // sudo: privilege escalation. A high-stakes inner command was already caught
  // by the full-string scan above (\b patterns match through the `sudo` prefix);
  // anything else still warrants review.
  if (/^sudo\s/.test(trimmed)) return "review";

  // SQL hidden inside an interpreter wrapper (python -c, node -e, heredoc),
  // a DB CLI (psql -c, sqlite3 db "...", mysql -e), or at the top of the
  // command. Severity comes from the statement, not the wrapper. (High-stakes
  // SQL — DROP/TRUNCATE/DELETE FROM — is already covered by the scan above.)
  const sql = findSqlInCommand(trimmed);
  if (sql) return classifySqlSeverity(sql);

  // File-mutating shell patterns (echo > X, tee, dd of=, touch, sed -i, cp, mv).
  // A file write/copy/move is a reversible LOCAL mutation, classified like the
  // Write/Edit tool: `warning` (logged) — UNLESS a target is a sensitive path
  // (system dir, secret store, shell rc, OKed config), which stays `review`.
  // (Overwriting a raw block device was already caught by the high-stakes scan.)
  const ops = extractShellWriteOps(trimmed);
  if (ops.length > 0) {
    const targets = ops.map((o) => o.target);
    return targets.some((t) => isSensitiveWritePath(t)) ? "review" : "warning";
  }

  // Outward sends (email/message) → review.
  for (const pattern of REVIEW_COMMANDS) {
    if (pattern.test(trimmed)) return "review";
  }

  // Local-mutation markers (local git, code execution, installs) → warning:
  // logged, no prompt. Everything else is a read or an unrecognized command with
  // no detected effect — and under the effect-based model that means `safe`.
  for (const pattern of WARNING_COMMANDS) {
    if (pattern.test(trimmed)) return "warning";
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

function openerFeedsInterpreter(line: string): boolean {
  return HEREDOC_INTERPRETER_RE.test(line);
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
      if (i < lines.length) i++; // drop the closing delimiter line
      continue;
    }
    i++;
  }
  return out.join("\n");
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

function classifyMcpTool(toolName: string): RiskTier {
  const parts = toolName.split("__");
  const tool = parts[parts.length - 1] || "";

  if (tool.startsWith("list_") || tool.startsWith("get_") || tool.startsWith("search_")) {
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
