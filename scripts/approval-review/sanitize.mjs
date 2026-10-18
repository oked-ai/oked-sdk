#!/usr/bin/env node
// Remove secrets and personal data before a real card goes into the repo.
//
//   node scripts/approval-review/sanitize.mjs --scan <file>...   exit 1 if a secret or personal data is found
//
// As a module: sanitize(value) returns a deep copy with keys, tokens, private
// keys, passwords, email addresses and home folder names replaced.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECRET_PATTERNS = [
  [/\b(?:ok|okm)_[A-Za-z0-9]{16,}\b/g, "ok_REDACTED"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "sk-REDACTED"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "ghp_REDACTED"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "github_pat_REDACTED"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xoxb-REDACTED"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIAREDACTED"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIzaREDACTED"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT_REDACTED"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "PRIVATE_KEY_REDACTED"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1REDACTED"],
  [/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s"'&,}]{6,}/gi, "$1REDACTED"],
];

const PERSONAL_PATTERNS = [
  [/\/Users\/[^/\s"']+\//g, "~/"],
  [/\/home\/[^/\s"']+\//g, "~/"],
  [/\b[A-Za-z0-9._%+-]+@(?!example\.com\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "user@example.com"],
];

export function sanitizeString(s) {
  let out = s;
  for (const [re, rep] of [...SECRET_PATTERNS, ...PERSONAL_PATTERNS]) out = out.replace(re, rep);
  return out;
}

export function sanitize(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

/** Every secret or personal-data match in a text, for the gate. */
export function scan(text) {
  const hits = [];
  for (const [re] of [...SECRET_PATTERNS, ...PERSONAL_PATTERNS]) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      // A value this tool already replaced is not a hit.
      if (/REDACTED|user@example\.com/.test(m[0])) continue;
      hits.push(m[0].length > 24 ? `${m[0].slice(0, 12)}…` : m[0]);
    }
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, ...files] = process.argv.slice(2);
  if (flag !== "--scan" || !files.length) {
    console.error("usage: sanitize.mjs --scan <file>...");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const hits = scan(readFileSync(f, "utf8"));
    if (hits.length) {
      bad++;
      console.log(`${f}: ${hits.length} finding(s): ${hits.slice(0, 5).join(", ")}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
