/**
 * Local script excerpt attached to an OpenClaw approval.
 *
 * For a recognized interpreter command, the first 4,096 bytes of the named
 * file are included so the approver can see what will run. Obvious secrets
 * in that excerpt are redacted first. This is a best-effort pass.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_SCRIPT_READ = 4096;

const SENSITIVE_WORDS = new Set(["password", "passwd", "pwd", "secret", "token", "key"]);

const ASSIGN =
  /^(\s*(?:export\s+)?)((?:const|let|var)\s+)?(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\3(\s*[=:]\s*)(.*)$/;

const PEM =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-.]+/)
    .flatMap((part) => part.split(/\s+/))
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

function isSensitiveName(name: string): boolean {
  return nameWords(name).some((word) => SENSITIVE_WORDS.has(word));
}

function redactAssignmentAndTokens(line: string): string {
  const assigned = line.replace(ASSIGN, (full, prefix: string, decl: string | undefined, quote: string, name: string, sep: string) => {
    if (!isSensitiveName(name)) return full;
    return `${prefix}${decl ?? ""}${quote}${name}${quote}${sep}[REDACTED]`;
  });
  return assigned
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED]");
}

/** Replace obvious secrets. The command string itself is not passed through here. */
export function redactScriptExcerpt(text: string): string {
  const withoutKeys = text.replace(PEM, "[REDACTED]");
  return withoutKeys
    .split(/\r?\n/)
    .map((line) => {
      const comment = line.match(/^(\s*(?:\/\/|#)\s*)(.*)$/);
      if (!comment) return redactAssignmentAndTokens(line);
      return `${comment[1]}${redactAssignmentAndTokens(comment[2] ?? "")}`;
    })
    .join("\n");
}

/**
 * Whether the approval should include `_script_body`.
 * Plugin config wins. Otherwise `OKED_SEND_SCRIPT_CONTENT=0` or `false` turns
 * it off. Anything else, including an unset variable, leaves the default on.
 */
export function resolveSendScriptContent(configValue?: boolean): boolean {
  if (typeof configValue === "boolean") return configValue;
  const raw = process.env.OKED_SEND_SCRIPT_CONTENT;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return true;
}

export function tryReadScriptFile(command: string): string | undefined {
  // python3 script.py, node script.js, ruby script.rb, and the same for
  // perl, deno run, and bun run. Skip -c/-e (those bodies are already in
  // the command string). Shell scripts such as `bash foo.sh` are not read.
  const m = command.trim().match(
    /\b(?:python\d?(?:\.\d+)?|node|ruby|perl|deno\s+run|bun\s+run)\s+(?:-[^\s]+\s+)*(['"]?)([^\s'"]+\.(?:py|js|mjs|ts|rb|pl))\1/,
  );
  if (!m) return undefined;
  let target = m[2];
  if (!target) return undefined;
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
  else if (!path.isAbsolute(target)) target = path.resolve(target);
  try {
    const fd = fs.openSync(target, "r");
    const buf = Buffer.alloc(MAX_SCRIPT_READ);
    const bytesRead = fs.readSync(fd, buf, 0, MAX_SCRIPT_READ, 0);
    fs.closeSync(fd);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  }
}
