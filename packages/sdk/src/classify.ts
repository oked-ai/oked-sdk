import path from "path";
import os from "os";
import type { RiskTier } from "./types.js";
import { findSqlInCommand } from "./describe.js";
import { TIER_ORDER } from "./degraded.js";

// Tier 1 - safe: auto-allow, no notification (Read, Glob, ls, git status, etc.)
// Tier 2 - warning: terminal log only, no push (Write/Edit inside project dir)
// Tier 3 - review: push notification required (Write/Edit outside project, unknown bash)
// Tier 4 - high_stakes: push + number matching (rm -rf, git push, DROP TABLE, etc.)

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

// Bash commands classified as safe (read-only, informational)
const SAFE_COMMANDS = [
  /^ls\b/,
  /^pwd$/,
  /^echo\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^date$/,
  /^whoami$/,
  /^which\b/,
  /^type\b/,
  /^file\b/,
  /^stat\b/,
  /^du\b/,
  /^df\b/,
  /^uname\b/,
  /^env$/,
  /^printenv\b/,
  /^node\s+(-v|--version)/,
  /^npm\s+(list|ls|--version|-v|view|info|outdated|audit)\b/,
  /^npx\s+-v/,
  /^git\s+(status|log|diff|branch|remote|show|tag|stash\s+list|ls-files|ls-tree|ls-remote|check-ignore|check-attr|rev-parse|rev-list|describe|cat-file|blame|shortlog|reflog|name-rev|whatchanged|for-each-ref|symbolic-ref|merge-base|var|grep|count-objects|show-ref|cherry|verify-commit|fsck)\b/,
  /^git\s+config\s+(--get|--get-all|--get-regexp|--list|-l)\b/,
  /^docker\s+(ps|images|inspect|logs)\b/,
  /^docker\s+compose\s+(ps|logs)\b/,
  /^tree\b/,
  /^find\b/,
  /^grep\b/,
  /^rg\b/,
  /^fd\b/,
  /^jq\b/,
  /^curl\s+-s.*\|\s*(jq|python|node)/,  // curl piped to parser (usually read-only)
  /^curl\b/,  // curl without -X defaults to GET (high-stakes patterns checked first)
  // himalaya (email CLI) read-only ops. Listing/reading mail or folder state
  // never mutates anything remotely. Only `message send|reply|forward` and
  // `message delete` / `folder delete|expunge|purge` matter; those land in
  // the review/high-stakes paths.
  /^himalaya\s+(account|folder|envelope|message\s+(?:read|export|search|copy|move)|attachment\s+(?:download|list)|template|search)\b/,
  // cd just changes directory — no side effect of its own. Any dangerous
  // command chained after it (`cd x && rm -rf`) is caught per-stage.
  /^cd\b/,
  // sed without -i / --in-place only prints to stdout (read-only). In-place
  // edits are detected as a write op (below) before this is reached.
  /^sed\b/,
  // gh read-only subcommands — listing/viewing PRs, issues, runs, etc.
  /^gh\s+(pr|issue|repo|run|workflow|release|api)\s+(list|view|status|diff|checks)\b/,
  // Test runners — running the project's own tests is part of the dev loop.
  // (Arbitrary node/npx/python execution is `warning`, see WARNING_COMMANDS.)
  /^npm\s+(test|t)\b/,
  /^npx\s+(tsx|ts-node|jest|vitest|mocha|ava|cypress|playwright|tsc)\b/,
  /^(jest|vitest|mocha|pytest|ava)\b/,
  /^python3?\s+-m\s+pytest\b/,
  // Shell control-flow keywords. A compound like `for f in *; do cmd; done`
  // is split on `;` into stages; these keyword stages carry no risk of their
  // own, and any real command in the body is classified per-stage. Dangerous
  // commands hidden in a $(...) on a keyword line are still caught by the
  // high-stakes scan, which runs on the full command first.
  /^(for|while|until|do|done|then|else|elif|fi|case|esac|if|select)\b/,
  /^(done|fi|esac|\}|\{|:|true|false)\s*$/,
];

// Bash commands classified as high stakes (destructive, irreversible, external)
const HIGH_STAKES_COMMANDS = [
  /\brm\b/,
  /\brm\b\s+(?:-[^\s]*[rf][^\s]*\s+)*-[^\s]*[rf][^\s]*\b/,
  /\brm\s+--recursive\b/,
  /\brm\b.*\s+\//,  // rm with absolute path
  /\brmdir\b/,
  /\btrash\b/,
  /\btrash-put\b/,
  /\bgit\s+push\b/,
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
  /\bkill\b/,
  /\bpkill\b/,
  /\bkillall\b/,
  /\bchmod\s+777\b/,
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
  // ssh to a remote host. Effects on the remote side cannot be undone from
  // here, so treat every interactive/remote-exec ssh as high_stakes. Matches
  // `ssh user@host ...` and `ssh -i key.pem ubuntu@1.2.3.4 ...`. The
  // \bssh\s+ prefix (whitespace required) excludes `ssh-keygen`/`ssh-add`/
  // `ssh-keyscan` which are local and reversible.
  /\bssh\s+(?:\S+\s+)*\S+@\S+/,
  // himalaya destructive ops. message delete + folder delete/expunge/purge
  // wipe mail from the server irreversibly; account delete wipes local config.
  /\bhimalaya\s+message\s+delete\b/,
  /\bhimalaya\s+folder\s+(delete|expunge|purge)\b/,
  /\bhimalaya\s+account\s+delete\b/,
];

// Commands that auto-allow without a phone prompt but are logged (warning):
// reversible/local actions where an audit line is enough.
const WARNING_COMMANDS = [
  // Local, reversible git ops — branch/stage/commit/stash/switch. They touch
  // only the local repo and can be undone (amend, reset, checkout).
  // Destructive/remote git (push, reset --hard, clean, checkout -- .) is matched
  // by HIGH_STAKES_COMMANDS above and wins first. `git stash drop|clear` is
  // excluded — those discard stashed work — so it stays `review`.
  /^git\s+add\b/,
  /^git\s+commit\b/,
  /^git\s+checkout\s+-b\b/,
  /^git\s+switch\b/,
  /^git\s+stash\b(?!\s+(?:drop|clear))/,
  // PR creation is reversible (a PR can be closed); the underlying branch push
  // is separately high_stakes.
  /^gh\s+pr\s+create\b/,
  // Arbitrary code execution (node/npx/python/npm run/bun/deno). The spawned
  // process can do anything and its syscalls don't pass back through OKed, so
  // we don't prompt but keep a local trail. Known test runners and read-only
  // version flags are handled as `safe` (SAFE_COMMANDS) before reaching here.
  /^node\b/,
  /^npx\b/,
  /^python3?\b/,
  /^npm\s+run\b/,
  /^bun\b/,
  /^deno\b/,
  // Package installs run dependency postinstall scripts (code execution), so
  // they're not "safe" — but they're a constant part of the dev loop, so log
  // (warning) rather than prompt.
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
  let resolved: string;
  try {
    resolved = path.resolve(filePath);
  } catch {
    return true;
  }
  const home = os.homedir();
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

function classifyBashCommand(command: string): RiskTier {
  if (!command) return "safe";

  // Strip heredoc bodies up front: their contents are literal data, not shell,
  // and must not be scanned for high-stakes tokens, operators, or redirects.
  const trimmed = stripHeredocBodies(command).trim();

  // rm/trash of only ephemeral temp files → warning (before the high-stakes
  // scan, which would otherwise match the bare `rm`).
  if (isEphemeralOnlyDeletion(trimmed)) return "warning";

  // High-stakes scan on the FULL command, before any splitting. These patterns
  // use \b and several intentionally span an operator (e.g. `curl … | bash`,
  // `wget … | sh` — download-and-execute), so they have to be matched against
  // the whole string. Most-restrictive-wins: a high-stakes match anywhere in a
  // compound command takes the whole command to high_stakes.
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

  // File-mutating shell patterns. Content-creation idioms (echo > X, tee,
  // dd of=, touch, sed -i) are the bypass route from a denied Write, so they're
  // classified exactly like the Write/Edit tool: `warning` unless a target is a
  // sensitive path (system dir, secret store, shell rc, OKed config), which
  // stays `review`. cp/mv (which can clobber/relocate existing files) stay
  // review.
  const ops = extractShellWriteOps(trimmed);
  if (ops.length > 0) {
    const creates = ops.filter((o) => o.kind !== "copy" && o.kind !== "move");
    if (creates.length > 0) {
      return creates.some((o) => isSensitiveWritePath(o.target)) ? "review" : "warning";
    }
    return "review";
  }

  // Check safe patterns
  for (const pattern of SAFE_COMMANDS) {
    if (pattern.test(trimmed)) return "safe";
  }

  // Reversible/local commands (local git, gh pr create, code execution) →
  // warning: logged, no phone approval. Checked after SAFE so read-only git
  // (status/log/`stash list`) and known test runners stay fully silent.
  for (const pattern of WARNING_COMMANDS) {
    if (pattern.test(trimmed)) return "warning";
  }

  // Default: review (require approval for unknown commands)
  return "review";
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
  return "review";
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
