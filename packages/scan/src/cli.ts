#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { formatReport, scan, ScanUsageError } from "./report.js";

const USAGE = `Usage: oked-scan [options]

Read local Claude Code transcripts and Codex CLI sessions. Print which
commands OKed's default rules would have paused for approval.

This command stays on this machine. It does not use the network and it
does not send telemetry.

Looks in ~/.claude/projects/**/*.jsonl (Bash tool calls) and
~/.codex/sessions/**/rollout-*.jsonl (shell tool calls). A missing
directory is skipped.

Options:
  --path <dir>     Read this directory instead of your home directory.
                   A home layout (~/.claude/projects, ~/.codex/sessions),
                   one of those folders, or a directory of transcript files.
  --since <days>   Only commands timestamped in the last <days> days.
                   Commands with no timestamp are still included.
  --json           Print the report as JSON.
  --version        Print the package version.
  -h, --help       Show this help.

Exit code 0 when the report is printed, including when nothing was found.
Exit code 1 when the arguments are wrong or --path does not exist.

Next step after a scan is the host install command, for example:
  npm install -g @oked/claude-code && oked init
  npm install -g @oked/codex && oked-codex init
`;

interface Flags {
  json: boolean;
  path?: string;
  since?: number;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new ScanUsageError(message);
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") continue;
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const sinceEq = arg.match(/^--since=(.*)$/);
    const pathEq = arg.match(/^--path=(.*)$/);
    if (arg === "--since" || sinceEq) {
      const raw = sinceEq ? sinceEq[1] : argv[++i];
      if (raw === undefined || raw.startsWith("-")) fail("Usage: --since <days>");
      if (!/^\d+$/.test(raw)) fail("--since expects a whole number of days (0 or more)");
      flags.since = Number(raw);
      continue;
    }
    if (arg === "--path" || pathEq) {
      const raw = pathEq ? pathEq[1] : argv[++i];
      if (!raw || raw.startsWith("-")) fail("Usage: --path <dir>");
      flags.path = raw;
      continue;
    }
    fail(`Unknown argument: ${arg}\n${USAGE}`);
  }
  return flags;
}

function packageVersion(): string {
  const json = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return json.version ?? "0.0.0";
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  let flags: Flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    if (err instanceof ScanUsageError) return 1;
    throw err;
  }
  try {
    const report = await scan({
      root: flags.path ?? homedir(),
      explicitRoot: flags.path !== undefined,
      sinceDays: flags.since,
    });
    if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(formatReport(report));
    return 0;
  } catch (err) {
    if (err instanceof ScanUsageError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
