import path from "path";
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
  /^git\s+(status|log|diff|branch|remote|show|tag|stash list)\b/,
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
  /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
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

// Ephemeral filesystem locations. Writes here have no lasting effect on
// their own — what matters is whatever subsequent command CONSUMES the file
// (e.g. `himalaya message send < /tmp/draft.eml`). Without this carve-out,
// every multi-step skill that drafts a temp file generates two approval
// prompts (the temp write + the real send) instead of one.
const EPHEMERAL_PATH_RE = /^(?:\/tmp\/|\/var\/tmp\/|\/private\/tmp\/|[A-Za-z]:[\\/](?:Windows[\\/]Temp|Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp)[\\/])/i;

function isEphemeralPath(filePath: string): boolean {
  if (!filePath) return false;
  return EPHEMERAL_PATH_RE.test(filePath);
}

function isInsideProject(filePath: string): boolean {
  if (!filePath) return false;
  try {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(process.cwd());
  } catch {
    return false;
  }
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

  // File-editing tools: warning if inside project or an ephemeral temp dir,
  // review otherwise. Temp-dir writes are "warning" because the file itself
  // can't do harm — only what consumes it can.
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath = toolInput.file_path as string;
    if (isEphemeralPath(filePath) || isInsideProject(filePath)) return "warning";
    return "review";
  }

  // Agent tool - review (spawns subagent, not directly destructive)
  if (toolName === "Agent") return "review";

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
    if (isEphemeralPath(writePath) || isInsideProject(writePath)) return "warning";
    return "review";
  }

  // Unknown tool - default to review (require approval)
  return "review";
}

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

/** Split a shell command on top-level pipe characters, ignoring `||` and
 * pipes inside quoted strings. Returns trimmed segments. */
function splitOnPipe(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      cur += ch;
      quote = ch;
    } else if (ch === "|" && cmd[i + 1] !== "|" && cmd[i - 1] !== "|") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function classifyBashCommand(command: string): RiskTier {
  if (!command) return "safe";

  const trimmed = command.trim();

  // Pipelines: classify each stage and take the highest tier. Without this,
  // `cat /tmp/draft.eml | himalaya message send` would match `^cat\b` first
  // and silently allow the email send. The right-hand stage is what matters.
  // Only split when there are 2+ stages so single commands don't recurse.
  const stages = splitOnPipe(trimmed);
  if (stages.length > 1) {
    return stages.reduce<RiskTier>(
      (worst, stage) => maxTier(worst, classifyBashCommand(stage)),
      "safe",
    );
  }

  // sudo: classify based on the inner command, not sudo itself
  if (/^sudo\s/.test(trimmed)) {
    const inner = trimmed.replace(/^sudo\s+/, "");
    for (const pattern of HIGH_STAKES_COMMANDS) {
      if (pattern.test(inner)) return "high_stakes";
    }
    return "review";
  }

  // SQL hidden inside an interpreter wrapper (python -c, node -e, heredoc),
  // a DB CLI (psql -c, sqlite3 db "...", mysql -e), or at the top of the
  // command. Severity comes from the statement, not the wrapper.
  const sql = findSqlInCommand(trimmed);
  if (sql) return classifySqlSeverity(sql);

  // Check high stakes first (most restrictive wins)
  for (const pattern of HIGH_STAKES_COMMANDS) {
    if (pattern.test(trimmed)) return "high_stakes";
  }

  // File-mutating shell patterns. Content-creation idioms (echo > X, tee,
  // dd of=, touch, sed -i, heredoc) require approval — they're exactly the
  // bypass route from a denied Write. cp/mv just rearrange existing bytes
  // and stay safe. Writes to ephemeral temp dirs (/tmp, %TEMP%) downgrade
  // to warning: the temp file alone can't do harm, only what consumes it.
  const ops = extractShellWriteOps(trimmed);
  if (ops.length > 0) {
    const creates = ops.filter((o) => o.kind !== "copy" && o.kind !== "move");
    if (creates.length > 0) {
      if (creates.every((o) => isEphemeralPath(o.target))) return "warning";
      return "review";
    }
    return "review";
  }

  // Check safe patterns
  for (const pattern of SAFE_COMMANDS) {
    if (pattern.test(trimmed)) return "safe";
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
export function extractShellWriteOps(command: string): ShellWriteOp[] {
  const cmd = command.trim();
  const ops: ShellWriteOp[] = [];

  // Output redirects: > path, >> path, &> path, 2> path. Try to pull the
  // literal content when the LHS is echo/printf.
  const redirRe = /(?:^|[^>])([12]?>>?|&>>?)\s*([^\s>|&;]+)/g;
  for (const m of cmd.matchAll(redirRe)) {
    const op = m[1];
    const target = unquote(m[2]);
    if (!target || /^\d+$/.test(target) || isDevNullish(target)) continue;
    const append = op === ">>" || op === "&>>";
    const content = extractEchoContent(cmd);
    ops.push({ kind: append ? "append" : "create", target, content });
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

  // sed -i
  if (/\bsed\b/.test(cmd) && /-i(?:\.\w+)?\b/.test(cmd)) {
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
