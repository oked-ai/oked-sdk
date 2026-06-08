/**
 * Context translation - converts raw tool calls into human-readable
 * approvals. Output is a sentence-shaped Rendered value: title + optional
 * subline + optional body (quoted block) + optional footnote.
 *
 * Surfaces (Telegram, dashboard) consume Title/Subline/Body/Footnote keys
 * from the `fields` payload. `describe()` returns just the title for
 * backwards-compatible single-line consumers (audit logs, SMS).
 */

import { extractShellWriteOps } from "./classify.js";

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

export function describe(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  // Single-line consumers (audit logs, SMS) get title + target inlined.
  const r = summarize(toolName, toolInput);
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
  toolInput: Record<string, unknown>
): Record<string, string> | null {
  const r = summarize(toolName, toolInput);
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

function summarize(toolName: string, toolInput: Record<string, unknown>): Rendered {
  const fileSizeBytes = typeof toolInput._file_size_bytes === "number" ? toolInput._file_size_bytes : undefined;
  switch (toolName) {
    case "Bash":
      return summarizeBash((toolInput.command as string) || "", fileSizeBytes);
    case "Write":
      return summarizeWrite(toolInput);
    case "Edit":
      return summarizeEdit(toolInput);
    case "NotebookEdit":
      return summarizeNotebookEdit(toolInput);
    case "Agent":
      return summarizeAgent(toolInput);
  }

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

function summarizeBash(command: string, sizeBytes?: number): Rendered {
  const cmd = (command || "").trim();
  if (!cmd) return { title: "Run empty command", kind: "unknown_bash" };

  // SQL detection runs before shell-write detection so that inline-interpreter
  // payloads (`node -e "..."`, `python -c "..."`) aren't misread as shell
  // redirects. JS arrow functions (`t => t.name`) and similar `=>` constructs
  // inside the quoted body otherwise match the `>` redirect regex.
  const sql = findSqlInCommand(cmd);
  if (sql) return summarizeSql(sql, cmd);

  const shellWrite = summarizeShellWrite(cmd);
  if (shellWrite) return shellWrite;

  // rm / trash — file deletion
  const rmMatch = cmd.match(/\b(?:rm|trash|trash-put|rmdir)\s+(?:(-rf?|-fr|--recursive|-r)\s+)?(.+)$/);
  if (rmMatch) {
    const recursive = !!rmMatch[1] || /^rm\s+-/.test(cmd);
    const targets = parseRmTargets(rmMatch[2]);

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

  // git
  if (/\bgit\s+push\b/.test(cmd)) {
    // Parse the remote + branch ignoring flags (-u, --force, --set-upstream, …)
    // so `git push -u origin feat` renders "feat → origin", not "origin → -u".
    const after = cmd.match(/\bgit\s+push\b(.*)$/s)?.[1] ?? "";
    const args = after.split(/\s+/).filter((a) => a && !a.startsWith("-"));
    const [remote, branch] = args;
    const target = remote && branch ? `${branch} → ${remote}` : remote || "current branch";
    const forced = /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b/.test(cmd);
    return forced
      ? { title: "Force push", target, kind: "git_force_push" }
      : { title: "Push", target, kind: "git_push" };
  }
  if (/\bgit\s+reset\s+--hard\b/.test(cmd)) return { title: "Hard reset — discard all local changes", kind: "git_reset_hard" };
  if (/\bgit\s+clean\s+-f/.test(cmd)) return { title: "Remove all untracked files", kind: "git_clean" };
  if (/\bgit\s+checkout\s+--\s+\./.test(cmd)) return { title: "Discard all unstaged changes", kind: "git_checkout" };
  if (/\bgit\s+restore\s+--staged\s+\./.test(cmd)) return { title: "Unstage all staged changes", kind: "git_restore" };
  if (/\bgit\s+commit\b/.test(cmd)) {
    // Pull a simple quoted -m message. Bail (show plain "Git commit") when the
    // message is a command substitution / heredoc — `-m "$(cat <<'EOF' … )"` —
    // since that has no clean inline title to extract.
    const m = cmd.match(/-m\s+["']([^"'$]+)["']/);
    return m ? { title: `Git commit "${truncate(m[1], 60)}"`, kind: "git_commit" } : { title: "Git commit", kind: "git_commit" };
  }

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

  // curl with method
  const curlMethod = cmd.match(/curl\s+[^|]*-X\s*(DELETE|POST|PUT|PATCH)/i);
  if (curlMethod) {
    const url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0] || "";
    const host = url ? extractHost(url) : "URL";
    const method = curlMethod[1].toUpperCase();
    const kind: OperationKind = method === "DELETE" ? "http_delete" : method === "POST" ? "http_post" : method === "PUT" ? "http_put" : "http_post";
    return {
      title: `${method} request to ${host}`,
      body: cmd.length > COMMAND_INLINE_MAX ? truncateBody(cmd) : undefined,
      kind,
    };
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

  // npm / npx
  const npmScript = cmd.match(/\bnpm\s+run\s+(\S+)/);
  if (npmScript) return { title: `Run npm script ${npmScript[1]}`, kind: "npm_run" };
  if (/\bnpm\s+install\b/.test(cmd)) return { title: "Install npm dependencies", kind: "npm_install" };
  if (/\bnpm\s+test\b/.test(cmd)) return { title: "Run npm tests", kind: "npm_test" };
  if (/\bnpm\s+publish\b/.test(cmd)) return { title: "Publish package to npm", kind: "npm_publish" };
  if (/\bnpm\s+unpublish\b/.test(cmd)) return { title: "Unpublish package from npm", kind: "npm_unpublish" };
  if (/\bnpx\s+.*\s+deploy\b/.test(cmd)) return { title: "Deploy via npx", body: truncateBody(cmd), kind: "npx_deploy" };

  // kill / sudo / chmod
  if (/\bkillall\b|\bpkill\b/.test(cmd)) return { title: "Kill processes", body: truncateBody(cmd), kind: "kill_process" };
  if (/\bkill\b/.test(cmd)) return { title: "Kill process", body: truncateBody(cmd), kind: "kill_process" };
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
const SQL_CONSUMER_RE =
  /(?:^|\||&&|;|\$\(|`)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|mariadb|sqlite3?|node|python\d?|ruby|perl|deno|bun)\b/;

export function findSqlInCommand(cmd: string): string | null {
  // Inline interpreter flags: node -e, python -c, ruby -e, perl -e. Anchored to
  // a command position so a SQL-looking string elsewhere doesn't match.
  const inline = cmd.match(/(?:^|\||&&|;|\$\()\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:node|python\d?|ruby|perl|deno|bun)\s+-[ec]\s+(?:"([\s\S]+?)"|'([\s\S]+?)')\s*$/);
  if (inline) {
    const body = inline[1] ?? inline[2];
    if (body && SQL_KEYWORDS_RE.test(body)) {
      return extractSqlFromScriptBody(body) ?? body;
    }
  }

  // psql -c "..." / mysql -e "..." / sqlite3 db "..." — outer-quoted statement.
  // Anchored to the start of the command so "psql"/"mysql" appearing inside an
  // argument (another tool's --body, etc.) can't trigger a false SQL match.
  const dq = cmd.match(/^(?:\s*\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|sqlite3?|mariadb)\b[^"]*"([\s\S]+?)"\s*$/i);
  if (dq) return dq[1];
  const sq = cmd.match(/^(?:\s*\w+=\S+\s+)*(?:sudo\s+)?(?:psql|mysql|sqlite3?|mariadb)\b[^']*'([\s\S]+?)'\s*$/i);
  if (sq) return sq[1];

  // Heredoc-piped script: <<EOF / <<'EOF' / <<"EOF" / <<-EOF. Only when the
  // command (outside the body) actually feeds the heredoc to a SQL CLI or
  // interpreter — otherwise a `gh`/`cat`/`mail` heredoc whose body merely
  // mentions SQL words would be misclassified as a statement to run.
  const hd = cmd.match(/<<-?\s*['"]?(\w+)['"]?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1\b/);
  if (hd) {
    const body = hd[2];
    const context = cmd.slice(0, hd.index) + cmd.slice((hd.index ?? 0) + hd[0].length);
    if (body && SQL_CONSUMER_RE.test(context) && SQL_KEYWORDS_RE.test(body)) {
      return extractSqlFromScriptBody(body) ?? body;
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
 * orendor@gmail.com" with the subject + sender, not a printf|himalaya
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

function summarizeMcp(toolName: string, input: Record<string, unknown>): Rendered {
  const parts = toolName.split("__");
  const server = parts[1] || "unknown";
  const tool = parts[2] || "";

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
    return { title: `${toWords(tool)} via ${server}`, kind: "unknown_tool" };
  }
  return { title: `${toWords(tool)} via ${server}`, kind: "unknown_tool" };
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

function toWords(snake: string): string {
  return snake.replace(/_/g, " ").split(" ").map((w) => (w.length <= 3 ? w.toUpperCase() : w)).join(" ");
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
