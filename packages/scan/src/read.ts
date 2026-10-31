import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { argvToShell } from "./redact.js";
import { SHELL_TOOL_NAMES, type Host } from "./rules.js";

export interface RawCommand {
  host: Host;
  command: string;
  /** ISO timestamp from the transcript, when the line had one. */
  timestamp: string | null;
  /** Stable id used to count a copied or streamed tool call once. */
  id: string;
}

export interface HostScan {
  directory: string;
  present: boolean;
  files: number;
  commands: number;
}

export interface Collected {
  commands: RawCommand[];
  hosts: Record<Host, HostScan>;
  badLines: number;
  unreadableFiles: number;
}

export interface CollectOptions {
  root: string;
  /** When false, a home directory with no transcript folders is not walked. */
  explicitRoot: boolean;
  sinceMs: number | null;
  nowMs: number;
}

const CODEX_LINE_TYPES = new Set(["session_meta", "response_item", "turn_context", "event_msg"]);
const CLAUDE_LINE_TYPES = new Set([
  "assistant",
  "user",
  "summary",
  "system",
  "attachment",
  "progress",
  "file-history-snapshot",
]);

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && accept(entry.name)) out.push(path);
    }
  }
  return out;
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampString(value: unknown): string | null {
  const ms = parseTime(value);
  if (ms === null) return null;
  return new Date(ms).toISOString();
}

function inWindow(timestamp: string | null, sinceMs: number | null, nowMs: number): boolean {
  if (sinceMs === null) return true;
  if (timestamp === null) return true;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return true;
  return ms >= nowMs - sinceMs;
}

async function readJsonl(file: string, onRecord: (value: unknown, lineNo: number) => void): Promise<number> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bad = 0;
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo += 1;
      const trimmed = line.replace(/^\uFEFF/, "").trim();
      if (!trimmed) continue;
      try {
        onRecord(JSON.parse(trimmed) as unknown, lineNo);
      } catch {
        bad += 1;
      }
    }
  } finally {
    lines.close();
  }
  return bad;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return asObject(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  return asObject(value);
}

function commandFromFields(record: Record<string, unknown>): string | null {
  const raw = record.command ?? record.cmd;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((part) => typeof part === "string")) {
    const command = argvToShell(raw as string[]);
    return command.trim() ? command : null;
  }
  return null;
}

interface Located {
  claudeDir: string;
  codexDir: string;
  claudePresent: boolean;
  codexPresent: boolean;
  sniff: boolean;
}

function locate(root: string): Located {
  const claudeDir = join(root, ".claude", "projects");
  const codexDir = join(root, ".codex", "sessions");
  const claudePresent = isDir(claudeDir);
  const codexPresent = isDir(codexDir);
  if (claudePresent || codexPresent) {
    return { claudeDir, codexDir, claudePresent, codexPresent, sniff: false };
  }
  if (basename(root) === "projects" && basename(dirname(root)) === ".claude" && isDir(root)) {
    return { claudeDir: root, codexDir, claudePresent: true, codexPresent: false, sniff: false };
  }
  if (basename(root) === "sessions" && isDir(root)) {
    return { claudeDir, codexDir: root, claudePresent: false, codexPresent: true, sniff: false };
  }
  return { claudeDir, codexDir, claudePresent: false, codexPresent: false, sniff: true };
}

function hostFromText(text: string): Host | null {
  const lines = text.split(/\n/).slice(0, 40);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = asObject(JSON.parse(trimmed) as unknown);
      const type = typeof value?.type === "string" ? value.type : "";
      if (CODEX_LINE_TYPES.has(type)) return "codex";
      if (CLAUDE_LINE_TYPES.has(type)) return "claude-code";
    } catch {
      // Keep scanning. A bad first line does not decide the file.
    }
  }
  return null;
}

async function sniffHostAsync(file: string): Promise<Host | null> {
  const stream = createReadStream(file, { encoding: "utf8", start: 0, end: 65535 });
  let text = "";
  try {
    for await (const chunk of stream) text += chunk;
  } catch {
    return null;
  }
  return hostFromText(text);
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (Array.isArray(content)) {
    return content.filter((block) => block && typeof block === "object") as Record<string, unknown>[];
  }
  const one = asObject(content);
  return one ? [one] : [];
}

function claudeCommandsFrom(value: unknown, file: string, lineNo: number): RawCommand[] {
  const entry = asObject(value);
  if (!entry) return [];
  const type = typeof entry.type === "string" ? entry.type : "";
  const message = asObject(entry.message);
  const role = typeof message?.role === "string" ? message.role : "";
  if (type !== "assistant" && role !== "assistant" && type !== "tool_use") return [];
  const timestamp = timestampString(entry.timestamp);
  const blocks: Record<string, unknown>[] = [];
  if (type === "tool_use") blocks.push(entry);
  if (message) blocks.push(...contentBlocks(message));
  const found: RawCommand[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    if (block.name !== "Bash") continue;
    const input = parseJsonObject(block.input) ?? {};
    const command = commandFromFields(input);
    if (!command) continue;
    const toolId = typeof block.id === "string" && block.id ? block.id : `${file}:${lineNo}:${found.length}`;
    found.push({
      host: "claude-code",
      command,
      timestamp,
      id: `claude:${toolId}`,
    });
  }
  return found;
}

function codexCommandFrom(value: unknown, file: string, lineNo: number): RawCommand | null {
  const entry = asObject(value);
  if (!entry) return null;
  const payload = asObject(entry.payload) ?? entry;
  const payloadType = typeof payload.type === "string" ? payload.type : "";
  const lineType = typeof entry.type === "string" ? entry.type : "";
  let name = "";
  let fields: Record<string, unknown> | null = null;
  let callId = "";

  if (lineType === "response_item" && payloadType === "function_call") {
    name = typeof payload.name === "string" ? payload.name : "";
    fields = parseJsonObject(payload.arguments);
    callId = typeof payload.call_id === "string" ? payload.call_id : "";
  } else if (lineType === "response_item" && payloadType === "local_shell_call") {
    name = "local_shell";
    const action = asObject(payload.action);
    fields = action;
    callId = typeof payload.call_id === "string" ? payload.call_id : "";
  } else if (lineType === "event_msg" && (payloadType === "exec_command_begin" || payloadType === "exec_start")) {
    name = "exec_command";
    fields = payload;
    callId = typeof payload.call_id === "string" ? payload.call_id : "";
  } else {
    return null;
  }

  if (!SHELL_TOOL_NAMES.has(name) || !fields) return null;
  const command = commandFromFields(fields);
  if (!command) return null;
  const timestamp = timestampString(entry.timestamp ?? payload.timestamp);
  const id = callId ? `codex:${callId}` : `codex:${file}:${lineNo}`;
  return { host: "codex", command, timestamp, id };
}

function pushUnique(
  target: RawCommand[],
  seen: Set<string>,
  command: RawCommand,
  sinceMs: number | null,
  nowMs: number,
): void {
  if (!inWindow(command.timestamp, sinceMs, nowMs)) return;
  if (seen.has(command.id)) return;
  seen.add(command.id);
  target.push(command);
}

async function readClaudeFile(
  file: string,
  target: RawCommand[],
  seen: Set<string>,
  sinceMs: number | null,
  nowMs: number,
): Promise<{ bad: number }> {
  const pending: RawCommand[] = [];
  const bad = await readJsonl(file, (value, lineNo) => {
    for (const command of claudeCommandsFrom(value, file, lineNo)) pending.push(command);
  });
  for (const command of pending) pushUnique(target, seen, command, sinceMs, nowMs);
  return { bad };
}

async function readCodexFile(
  file: string,
  target: RawCommand[],
  seen: Set<string>,
  sinceMs: number | null,
  nowMs: number,
): Promise<{ bad: number }> {
  const pending: RawCommand[] = [];
  const bad = await readJsonl(file, (value, lineNo) => {
    const command = codexCommandFrom(value, file, lineNo);
    if (command) pending.push(command);
  });
  for (const command of pending) pushUnique(target, seen, command, sinceMs, nowMs);
  return { bad };
}

export async function collectCommands(options: CollectOptions): Promise<Collected> {
  const located = locate(options.root);
  const seen = new Set<string>();
  const commands: RawCommand[] = [];
  let badLines = 0;
  let unreadableFiles = 0;
  let claudeFiles = 0;
  let codexFiles = 0;

  const take = async (file: string, host: Host) => {
    const before = commands.length;
    try {
      const result =
        host === "claude-code"
          ? await readClaudeFile(file, commands, seen, options.sinceMs, options.nowMs)
          : await readCodexFile(file, commands, seen, options.sinceMs, options.nowMs);
      badLines += result.bad;
      if (host === "claude-code") claudeFiles += 1;
      else codexFiles += 1;
    } catch {
      commands.length = before;
      unreadableFiles += 1;
    }
  };

  if (located.claudePresent) {
    for (const file of walkFiles(located.claudeDir, (name) => name.endsWith(".jsonl"))) {
      await take(file, "claude-code");
    }
  }
  if (located.codexPresent) {
    for (const file of walkFiles(located.codexDir, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))) {
      await take(file, "codex");
    }
  }

  if (located.sniff && options.explicitRoot) {
    const files = isFile(options.root)
      ? options.root.endsWith(".jsonl")
        ? [options.root]
        : []
      : isDir(options.root)
        ? walkFiles(options.root, (name) => name.endsWith(".jsonl"))
        : [];
    for (const file of files) {
      const host = await sniffHostAsync(file);
      if (host) await take(file, host);
    }
    if (files.length > 0) {
      if (claudeFiles > 0) located.claudePresent = true;
      if (codexFiles > 0) located.codexPresent = true;
    }
  }

  const claudeCommands = commands.filter((command) => command.host === "claude-code").length;
  const codexCommands = commands.filter((command) => command.host === "codex").length;

  return {
    commands,
    badLines,
    unreadableFiles,
    hosts: {
      "claude-code": {
        directory: located.claudePresent && located.sniff ? options.root : located.claudeDir,
        present: located.claudePresent,
        files: claudeFiles,
        commands: claudeCommands,
      },
      codex: {
        directory: located.codexPresent && located.sniff ? options.root : located.codexDir,
        present: located.codexPresent,
        files: codexFiles,
        commands: codexCommands,
      },
    },
  };
}
