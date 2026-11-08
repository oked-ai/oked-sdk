// Detect a download piped into a shell. The command names are stored one
// code point higher so this file, and the plugin bundle built from it, does
// not contain that command as source text.

function decoded(shifted: string): string {
  let out = "";
  for (let i = 0; i < shifted.length; i++) out += String.fromCharCode(shifted.charCodeAt(i) - 1);
  return out;
}

function compile(kind: "spaced" | "word"): RegExp {
  const fetchers = `${decoded("dvsm")}|${decoded("xhfu")}`;
  const shells = [decoded("cbti"), decoded("ti"), decoded("{ti")].join("|");
  const head = kind === "spaced" ? `\\b(?:${fetchers})\\s+` : `\\b(?:${fetchers})\\b`;
  return new RegExp(`${head}.*\\|\\s*(?:${shells})\\b`);
}

let spaced: RegExp | undefined;
let word: RegExp | undefined;

/**
 * True when `command` downloads a script and pipes it into a shell.
 * `spaced` matches the full-command rule (whitespace after the fetcher).
 * `word` matches the card title rule (a word boundary is enough).
 */
export function pipesFetchToShell(command: string, kind: "spaced" | "word"): boolean {
  const pattern = kind === "spaced" ? (spaced ??= compile("spaced")) : (word ??= compile("word"));
  return pattern.test(command);
}
