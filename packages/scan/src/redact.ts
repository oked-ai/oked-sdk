import { homedir } from "node:os";

/** Display length for one command in the report. */
export const COMMAND_DISPLAY_MAX = 120;

const TOKEN_PATTERNS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Replace secrets-looking tokens with `[redacted]`.
 * The command text is kept so the report still shows what would have paused.
 */
export function redactSecrets(command: string): string {
  let out = command;
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  // Greedy userinfo so a password that itself contains @ is still covered.
  // `https://example.com/a@b` has no userinfo: the host cannot include a slash.
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s]+)@/gi, "$1[redacted]@");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(
    /(^|[\s;|&])((?:[A-Za-z_][A-Za-z0-9_]*?)(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1$2=[redacted]",
  );
  out = out.replace(
    /(^|\s)(--(?:password|token|api-key|api_key|secret|auth|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1$2 [redacted]",
  );
  return out;
}

/** Show a home directory as `~` so a pasted report does not include the account name. */
export function replaceHome(command: string, home = homedir()): string {
  if (!home || home === "/" || !command.includes(home)) return command;
  return command.split(home).join("~");
}

export function displayPath(path: string, home = homedir()): string {
  if (!home || home === "/" || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (!rest) return "~";
  return rest.startsWith("/") ? `~${rest}` : `~/${rest}`;
}

/** Redact, then truncate. Redaction runs on the full string so a cut cannot leave a token prefix. */
export function displayCommand(command: string, home = homedir()): string {
  const redacted = redactSecrets(replaceHome(command, home));
  if (redacted.length <= COMMAND_DISPLAY_MAX) return redacted;
  return `${redacted.slice(0, COMMAND_DISPLAY_MAX - 3)}...`;
}

/** Quote one argv element the way a shell would, so `classify()` sees the same words. */
export function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Turn a Codex argv into one shell string.
 * A single element is already the command (it may contain spaces).
 * Several elements are argv: `["bash","-lc","rm -rf /var"]` becomes `bash -lc 'rm -rf /var'`.
 */
export function argvToShell(argv: readonly string[]): string {
  if (argv.length === 1) return argv[0];
  return argv.map(quoteArg).join(" ");
}
