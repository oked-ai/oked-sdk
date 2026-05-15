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
  title: string;
  target?: string;
  annotation?: string;
  subline?: string;
  body?: string;
  footnote?: string;
  kind: OperationKind;
}

export function describe(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const r = summarize(toolName, toolInput);
  if (r.target) {
    if (r.title === "Delete file recursively") return `Delete ${r.target} recursively`;
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

// -----------------------------------------------------------------------
// Top-level dispatch
// -----------------------------------------------------------------------

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

// -----------------------------------------------------------------------
// Bash / shell - semantic rerendering
// -----------------------------------------------------------------------

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

  // rm / trash - file deletion
  const rmMatch = cmd.match(/\b(?:rm|trash|trash-put|rmdir)\s+(?:(-rf?|-fr|--recursive|-r)\s+)?(.+)$/);
  if (rmMatch) {
    const recursive = !!rmMatch[1] || /^rm\s+-/.test(cmd);
    const target = rmMatch[2].trim().split(/\s+/)[0] || "files";
    const sqlExt = !recursive && /\.sql$/i.test(target);
    return {
      title: recursive ? "Delete file recursively" : sqlExt ? "Delete SQL file" : "Delete file",
      target: shortenPath(stripQuotes(target)),
      annotation: sizeBytes !== undefined ? `(${formatByteCount(sizeBytes)})` : undefined,
      kind: "file_delete",
    };
  }

  // git
  if (/\bgit\s+push\s+(?:--force|-f)\b/.test(cmd)) {
    const m = cmd.match(/git\s+push\s+(?:--force|-f)\s+(\S+)\s+(\S+)/);
    return { title: "Force push", target: m ? `${m[2]} -> ${m[1]}` : "current branch", kind: "git_force_push" };
  }
  if (/\bgit\s+push\b/.test(cmd)) {
    const m = cmd.match(/git\s+push\s+(\S+)\s+(\S+)/);
    return { title: "Push", target: m ? `${m[2]} -> ${m[1]}` : "current branch", kind: "git_push" };
  }
  if (/\bgit\s+reset\s+--hard\b/.test(cmd)) return { title: "Hard reset - discard all local changes", kind: "git_reset_hard" };
  if (/\bgit\s+clean\s+-f/.test(cmd)) return { title: "Remove all untracked files", kind: "git_clean" };
  if (/\bgit\s+checkout\s+--\s+\./.test(cmd)) return { title: "Discard all unstaged changes", kind: "git_checkout" };
  if (/\bgit\s+restore\s+--staged\s+\./.test(cmd)) return { title: "Unstage all staged changes", kind: "git_restore" };
  if (/\bgit\s+commit\b/.test(cmd)) {
    const m = cmd.match(/-m\s+["']([^"']+)["']/);
    return m ? { title: `Git commit "${m[1]}"`, kind: "git_commit" } : { title: "Git commit", kind: "git_commit" };
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
      body: cmd.length > COMMAND_INLINE_MAX ? cmd : undefined,
      kind,
    };
  }
  if (/\bwget\b.*\|\s*(bash|sh|zsh)\b/.test(cmd) || /\bcurl\b.*\|\s*(bash|sh|zsh)\b/.test(cmd)) {
    const url = cmd.match(/https?:\/\/[^\s|'"]+/)?.[0];
    return {
      title: `Download and execute script${url ? ` from ${extractHost(url)}` : ""}`,
      body: cmd,
      kind: "http_pipe_to_shell",
    };
  }

  // Multi-step pipeline
  if (/&&|\|\||;/.test(cmd)) return { title: "Run command", body: cmd, kind: "shell_pipeline" };

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
  if (/\bnpx\s+.*\s+deploy\b/.test(cmd)) return { title: "Deploy via npx", body: cmd, kind: "npx_deploy" };

  // kill / sudo / chmod
  if (/\bkillall\b|\bpkill\b/.test(cmd)) return { title: "Kill processes", body: cmd, kind: "kill_process" };
  if (/\bkill\b/.test(cmd)) return { title: "Kill process", body: cmd, kind: "kill_process" };
  if (/\bsudo\b/.test(cmd)) {
    const inner = cmd.replace(/^sudo\s+/, "");
    return { title: `Run as root: ${truncate(inner, COMMAND_INLINE_MAX)}`, body: cmd, kind: "sudo" };
  }
  if (/\bchmod\s+777\b/.test(cmd)) {
    const target = cmd.match(/chmod\s+777\s+(\S+)/)?.[1] || "file";
    return { title: `Make ${target} world-writable (chmod 777)`, kind: "chmod_777" };
  }

  if (cmd.length > COMMAND_INLINE_MAX) return { title: "Run command", body: cmd, kind: "unknown_bash" };
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
        target: op.source ? `${shortenPath(op.source)} -> ${path}` : path,
        kind: "file_copy",
      };
    case "move":
      return {
        title: "Move file",
        target: op.source ? `${shortenPath(op.source)} -> ${path}` : path,
        kind: "file_move",
      };
  }
}

export const SQL_KEYWORDS_RE = /\b(DROP\s+(TABLE|DATABASE|INDEX|VIEW)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+(?:OR\s+\w+\s+)?INTO|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE)\b/i;

function extractSqlFromScriptBody(body: string): string | null {
  const sqls: string[] = [];
  const re = /\.(?:execute|executemany|query|run|exec)\s*\(\s*(?:["'`])([\s\S]+?)(?:["'`])\s*[,)]/gi;
  for (const m of body.matchAll(re)) {
    const sql = m[1].trim().replace(/\s+/g, " ");
    if (SQL_KEYWORDS_RE.test(sql)) sqls.push(sql);
  }
  return sqls.length > 0 ? sqls.join("\n") : null;
}

export function findSqlInCommand(cmd: string): string | null {
  // Inline interpreter flags: node -e, python -c, ruby -e, perl -e.
  const inline = cmd.match(/\b(?:node|python\d?|ruby|perl|deno|bun)\s+-[ec]\s+(?:"([\s\S]+?)"|'([\s\S]+?)')\s*$/);
  if (inline) {
    const body = inline[1] ?? inline[2];
    if (body && SQL_KEYWORDS_RE.test(body)) {
      return extractSqlFromScriptBody(body) ?? body;
    }
  }

  // psql -c "..." / mysql -e "..." / sqlite3 db "..."
  const dq = cmd.match(/(?:psql|mysql|sqlite3?|mariadb)\b[^"]*"([\s\S]+?)"\s*$/i);
  if (dq) return dq[1];
  const sq = cmd.match(/(?:psql|mysql|sqlite3?|mariadb)\b[^']*'([\s\S]+?)'\s*$/i);
  if (sq) return sq[1];

  // Heredoc-piped script
  const hd = cmd.match(/<<-?\s*['"]?(\w+)['"]?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1\b/);
  if (hd) {
    const body = hd[2];
    if (body && SQL_KEYWORDS_RE.test(body)) {
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
  const dropM = trimmed.match(/\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)["`]?/i);
  if (dropM) {
    return {
      title: `Drop ${dropM[1].toLowerCase()}`,
      target: dropM[2],
      body: sql.length > COMMAND_INLINE_MAX ? sql : undefined,
      kind: "sql_drop",
    };
  }
  const truncateM = trimmed.match(/\bTRUNCATE\s+(?:TABLE\s+)?["`]?([\w.]+)["`]?/i);
  if (truncateM) {
    return { title: "Truncate table", target: truncateM[1], annotation: "(delete all rows)", body: sql, kind: "sql_truncate" };
  }
  const alterM = trimmed.match(/\bALTER\s+TABLE\s+["`]?([\w.]+)["`]?/i);
  if (alterM) {
    return { title: "Alter table", target: alterM[1], body: sql, kind: "sql_alter" };
  }
  const createM = trimmed.match(/\bCREATE\s+(TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?/i);
  if (createM) {
    return { title: `Create ${createM[1].toLowerCase()}`, target: createM[2], body: sql, kind: "sql_create" };
  }
  const deleteM = trimmed.match(/\bDELETE\s+FROM\s+["`]?([\w.]+)["`]?/i);
  if (deleteM) {
    const thisStmt = stmtSlice(trimmed, deleteM.index ?? 0);
    const hasWhere = /\bWHERE\b/i.test(thisStmt);
    return {
      title: hasWhere ? "Delete rows from" : "Delete ALL rows from",
      target: deleteM[1],
      body: sql,
      kind: hasWhere ? "sql_delete_rows" : "sql_delete_all_rows",
    };
  }
  const updateM = trimmed.match(/\bUPDATE\s+["`]?([\w.]+)["`]?\s+SET/i);
  if (updateM) {
    const thisStmt = stmtSlice(trimmed, updateM.index ?? 0);
    const hasWhere = /\bWHERE\b/i.test(thisStmt);
    return {
      title: hasWhere ? "Update rows in" : "Update EVERY row in",
      target: updateM[1],
      body: sql,
      kind: hasWhere ? "sql_update_rows" : "sql_update_every_row",
    };
  }
  const insertM = trimmed.match(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?([\w.]+)["`]?/i);
  if (insertM) {
    return { title: "Insert rows into", target: insertM[1], body: sql, kind: "sql_insert" };
  }
  return { title: "Run SQL statement", body: sql || originalCommand, kind: "sql_query" };
}

// -----------------------------------------------------------------------
// File operations
// -----------------------------------------------------------------------

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
        ? content.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "..."
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
      footnote = `... and ${diff.lines.length - DIFF_HUNK_MAX_LINES} more lines`;
    }
    return {
      title: "Edit file",
      target: shortPath,
      annotation: `+${diff.added} -${diff.removed}`,
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
  for (const l of oldLines) lines.push(`- ${l}`);
  for (const l of newLines) lines.push(`+ ${l}`);
  return { lines, added: newLines.length, removed: oldLines.length };
}

function summarizeNotebookEdit(input: Record<string, unknown>): Rendered {
  const filePath = (input.notebook_path ?? input.file_path) as string | undefined;
  return filePath
    ? { title: "Edit notebook", target: shortenPath(filePath), kind: "file_edit" }
    : { title: "Edit notebook", kind: "file_edit" };
}

// -----------------------------------------------------------------------
// Agents & MCP
// -----------------------------------------------------------------------

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

// -----------------------------------------------------------------------
// Email / payment / chat message
// -----------------------------------------------------------------------

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
    sublineParts.push(`attachment: ${list.join(", ")}`);
  }

  let bodyText: string | undefined;
  if (typeof body === "string" && body.trim()) {
    bodyText = body.length > BODY_PREVIEW_MAX
      ? body.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "..."
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
      ? text.slice(0, BODY_PREVIEW_MAX - 1).trimEnd() + "..."
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

// -----------------------------------------------------------------------
// Fallback
// -----------------------------------------------------------------------

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

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatMoney(amount: unknown, currency: unknown): string {
  const num = typeof amount === "number" ? amount : parseFloat(String(amount));
  if (isNaN(num)) return String(amount);
  const cur = String(currency || "").toLowerCase();
  const symbols: Record<string, string> = { usd: "$", eur: "EUR ", gbp: "GBP ", jpy: "JPY ", cad: "CA$", aud: "A$" };
  const symbol = symbols[cur] || (cur ? `${cur.toUpperCase()} ` : "");
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

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "..." : s;
}

function stmtSlice(trimmed: string, startIdx: number): string {
  const after = trimmed.slice(startIdx);
  const nextKw = after.slice(10).search(/\b(DELETE|INSERT|UPDATE|DROP|CREATE|ALTER|TRUNCATE)\b/i);
  return nextKw >= 0 ? after.slice(0, nextKw + 10) : after;
}
