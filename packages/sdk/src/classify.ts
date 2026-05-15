import { isAbsolute, relative, resolve } from "node:path";
import type { RiskTier } from "./types.js";
import { findSqlInCommand } from "./describe.js";

const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "TodoRead",
  "TaskGet",
  "TaskList",
]);

const REVIEW_TOOLS = new Set<string>([]);
const HIGH_STAKES_TOOLS = new Set<string>([]);

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
  /^curl\s+-s.*\|\s*(jq|python|node)/,
  /^curl\b/,
];

const HIGH_STAKES_COMMANDS = [
  /\brm\s+(-rf?|--recursive)\b/,
  /\brm\b.*\s+\//,
  /\btrash\b/,
  /\btrash-put\b/,
  /\bgit\s+push\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+push\s+-f\b/,
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
  /\bcurl\s+.*-X\s*(DELETE|PUT|POST)\b/,
  /\bcurl\s+.*--request\s*(DELETE|PUT|POST)\b/,
  /\bwget\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bcurl\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bnpm\s+publish\b/,
  /\bnpm\s+unpublish\b/,
  /\bnpx\s+.*\s+deploy\b/,
];

function isInsideProject(filePath: string, cwd = process.cwd()): boolean {
  if (!filePath) return false;
  try {
    const root = resolve(cwd);
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
    const rel = relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

export function classify(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd = process.cwd()
): RiskTier {
  if (SAFE_TOOLS.has(toolName)) return "safe";
  if (HIGH_STAKES_TOOLS.has(toolName)) return "high_stakes";
  if (REVIEW_TOOLS.has(toolName)) return "review";

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath =
      toolName === "NotebookEdit"
        ? (toolInput.notebook_path ?? toolInput.file_path)
        : toolInput.file_path;
    return isInsideProject(filePath as string, cwd) ? "warning" : "review";
  }

  if (toolName === "Agent") return "review";

  if (toolName === "Bash") {
    return classifyBashCommand(toolInput.command as string);
  }

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
    return isInsideProject(writePath, cwd) ? "warning" : "review";
  }

  return "review";
}

function classifyBashCommand(command: string): RiskTier {
  if (!command) return "safe";

  const trimmed = command.trim();

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

  for (const pattern of HIGH_STAKES_COMMANDS) {
    if (pattern.test(trimmed)) return "high_stakes";
  }

  // File-mutating shell patterns. Content-creation idioms (echo > X, tee,
  // dd of=, touch, sed -i, heredoc) always require approval - they're
  // exactly the bypass route from a denied Write. cp/mv just rearrange
  // existing bytes and stay safe.
  const ops = extractShellWriteOps(trimmed);
  if (ops.length > 0) {
    const creates = ops.filter((o) => o.kind !== "copy" && o.kind !== "move");
    if (creates.length > 0) return "review";
    return "safe";
  }

  for (const pattern of SAFE_COMMANDS) {
    if (pattern.test(trimmed)) return "safe";
  }

  return "review";
}

function classifySqlSeverity(sql: string): RiskTier {
  if (/\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\b/i.test(sql)) return "high_stakes";
  if (/\bTRUNCATE\b/i.test(sql)) return "high_stakes";
  if (/\bDELETE\s+FROM\b/i.test(sql)) return "high_stakes";
  if (/\bUPDATE\s+\w+\s+SET\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) return "high_stakes";
  return "review";
}

export type ShellWriteKind = "create" | "append" | "edit" | "touch" | "copy" | "move";

export interface ShellWriteOp {
  kind: ShellWriteKind;
  target: string;
  source?: string;
  content?: string;
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
  if (tool.startsWith("delete_") || tool.startsWith("drop_") || tool.startsWith("remove_")) {
    return "high_stakes";
  }
  if (tool.startsWith("send_") || tool.startsWith("create_") || tool.startsWith("update_")) {
    return "review";
  }

  return "review";
}
