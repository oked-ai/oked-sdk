import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RiskTier } from "@oked/sdk";
import { displayCommand, displayPath } from "./redact.js";
import { collectCommands, type HostScan } from "./read.js";
import { classifierVersion, classifyCommand, pausesForApproval, type Host } from "./rules.js";

const TOP_RISKY = 8;

const TIER_RANK: Record<RiskTier, number> = {
  high_stakes: 0,
  review: 1,
  warning: 2,
  safe: 3,
};

const CLASSIFICATION_NOTES = [
  "Tiers come from @oked/sdk classify(), the same function the hooks call. Custom rules are not applied.",
  "A command would have paused when the tier is review or high_stakes. warning and safe would have run.",
  "Claude Code is classified with the Bash sandbox not containing child processes, which is the default. Test runners and scripts then count as review.",
  "Codex is classified the way the Codex hook classifies commands. Those runners stay allowed there.",
];

const DECISION_NOTE =
  "Decisions happen in Telegram or on the web dashboard (https://oked.ai/dashboard). The iPhone app is coming soon.";

const NOTES = [...CLASSIFICATION_NOTES, DECISION_NOTE];

/** How many high-stakes kinds to name in the closing line. */
const NAMED_CATEGORIES = 3;

/**
 * Plain words for high-stakes kinds. Kinds that share a phrase are counted
 * together. Kinds with no entry (including unknown_bash) stay out of the
 * sentence so the report does not invent a name.
 */
const PLAIN_HIGH_STAKES: Record<string, { one: string; many: string }> = {
  file_delete: { one: "rm -rf", many: "rm -rf" },
  git_force_push: { one: "force-push", many: "force-pushes" },
  git_reset_hard: { one: "hard reset", many: "hard resets" },
  git_clean: { one: "git clean", many: "git clean" },
  git_checkout: { one: "discarded change", many: "discarded changes" },
  git_branch_delete: { one: "branch delete", many: "branch deletes" },
  sql_drop: { one: "destructive SQL", many: "destructive SQL" },
  sql_truncate: { one: "destructive SQL", many: "destructive SQL" },
  sql_delete_rows: { one: "destructive SQL", many: "destructive SQL" },
  sql_delete_all_rows: { one: "destructive SQL", many: "destructive SQL" },
  sql_update_every_row: { one: "destructive SQL", many: "destructive SQL" },
  deploy: { one: "prod deploy", many: "prod deploys" },
  npx_deploy: { one: "prod deploy", many: "prod deploys" },
  docker_rm: { one: "docker rm", many: "docker rm" },
  docker_rmi: { one: "docker image removal", many: "docker image removals" },
  docker_prune: { one: "docker prune", many: "docker prune" },
  docker_down: { one: "docker compose down", many: "docker compose down" },
  npm_publish: { one: "npm publish", many: "npm publish" },
  npm_unpublish: { one: "npm unpublish", many: "npm unpublish" },
  chmod_777: { one: "chmod 777", many: "chmod 777" },
  http_pipe_to_shell: { one: "pipe to a shell", many: "pipes to a shell" },
  kill_process: { one: "process kill", many: "process kills" },
  email_delete: { one: "email delete", many: "email deletes" },
  email_purge: { one: "mailbox purge", many: "mailbox purges" },
  payment_charge: { one: "payment", many: "payments" },
  payment_create: { one: "payment", many: "payments" },
};

export class ScanUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanUsageError";
  }
}

export interface CommandRow {
  host: Host;
  tier: RiskTier;
  category: string;
  /** Redacted and truncated. Safe to paste. */
  command: string;
  paused: boolean;
  timestamp: string | null;
}

export interface RiskyGroup {
  host: Host;
  tier: RiskTier;
  category: string;
  command: string;
  count: number;
}

export interface HostSummary {
  directory: string;
  present: boolean;
  files: number;
  commands: number;
}

export interface ScanReport {
  version: string;
  classifier: string;
  localOnly: true;
  network: false;
  telemetry: false;
  generatedAt: string;
  sinceDays: number | null;
  hosts: Record<Host, HostSummary>;
  totals: {
    commands: number;
    paused: number;
    byTier: Record<RiskTier, number>;
    byCategory: Record<string, number>;
  };
  pausedByCategory: Record<string, number>;
  topRisky: RiskyGroup[];
  /** Every classified command, redacted. Grouped duplicates are listed once in `topRisky`. */
  commands: CommandRow[];
  badLines: number;
  unreadableFiles: number;
  notes: string[];
  /** Shell command that installs the host hook for the history that was found. */
  next: string;
}

export interface ScanOptions {
  /** Home directory, or a transcript root when `explicitRoot` is set. Defaults to the user home. */
  root?: string;
  explicitRoot?: boolean;
  /** Only commands timestamped within this many days. Undated commands stay. */
  sinceDays?: number;
  now?: Date;
  home?: string;
}

export interface FormatReportOptions {
  /** Print the classification notes. The default text report leaves them out. */
  verbose?: boolean;
}

function packageVersion(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const json = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  return json.version ?? "0.0.0";
}

export function nextStep(hosts: { claude: boolean; codex: boolean }): string {
  if (hosts.claude && hosts.codex) {
    return "npm install -g @oked/claude-code @oked/codex && oked init && oked-codex init";
  }
  if (hosts.codex && !hosts.claude) {
    return "npm install -g @oked/codex && oked-codex init";
  }
  return "npm install -g @oked/claude-code && oked init";
}

function emptyTiers(): Record<RiskTier, number> {
  return { safe: 0, warning: 0, review: 0, high_stakes: 0 };
}

function showHost(scan: HostScan, home: string): HostSummary {
  return {
    directory: displayPath(scan.directory, home),
    present: scan.present,
    files: scan.files,
    commands: scan.commands,
  };
}

function pad(n: number): string {
  return String(n).padStart(4);
}

function hostLine(label: string, host: HostSummary, missing: string): string {
  const name = label.padEnd(14);
  if (!host.present) return `${name}no ${missing} at ${host.directory}`;
  if (host.files === 0) return `${name}no session files in ${host.directory}`;
  const commands = host.commands === 1 ? "command" : "commands";
  const files = host.files === 1 ? "file" : "files";
  return `${name}${host.commands} ${commands} in ${host.files} ${files}`;
}

function englishList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The two or three most common high-stakes kinds, in plain words. */
function namedHighStakes(commands: CommandRow[]): string[] {
  const buckets = new Map<string, { count: number; one: string; many: string }>();
  for (const row of commands) {
    if (row.tier !== "high_stakes") continue;
    const plain = PLAIN_HIGH_STAKES[row.category];
    if (!plain) continue;
    const existing = buckets.get(plain.many);
    if (existing) existing.count += 1;
    else buckets.set(plain.many, { count: 1, one: plain.one, many: plain.many });
  }
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.one.localeCompare(b.one))
    .slice(0, NAMED_CATEGORIES)
    .map((bucket) => `${bucket.count} ${bucket.count === 1 ? bucket.one : bucket.many}`);
}

function closingLine(report: ScanReport): string {
  if (report.totals.paused === 0) {
    return "No risky commands found in this history, and OKed would pause things like rm -rf, force-push and prod deploys.";
  }
  const named = namedHighStakes(report.commands);
  const lead = `OKed would have paused ${report.totals.paused} of these commands`;
  if (named.length === 0) return `${lead}.`;
  return `${lead}, including ${englishList(named)}.`;
}

export function formatReport(report: ScanReport, options: FormatReportOptions = {}): string {
  const lines: string[] = [];
  lines.push(`OKed scan ${report.version}`);
  lines.push("Local only. This scan does not use the network and does not send telemetry.");
  lines.push("");
  lines.push(hostLine("Claude Code", report.hosts["claude-code"], "transcripts"));
  lines.push(hostLine("Codex CLI", report.hosts.codex, "sessions"));
  lines.push(
    `Window        ${report.sinceDays === null ? "all history" : `last ${report.sinceDays} ${report.sinceDays === 1 ? "day" : "days"}`}`,
  );
  if (report.badLines > 0) {
    lines.push(`Skipped ${report.badLines} unreadable ${report.badLines === 1 ? "line" : "lines"}.`);
  }
  if (report.unreadableFiles > 0) {
    lines.push(`Skipped ${report.unreadableFiles} unreadable ${report.unreadableFiles === 1 ? "file" : "files"}.`);
  }
  lines.push("");
  lines.push(`Commands             ${pad(report.totals.commands)}`);
  lines.push(`Would have paused    ${pad(report.totals.paused)}`);
  lines.push(`  high_stakes        ${pad(report.totals.byTier.high_stakes)}`);
  lines.push(`  review             ${pad(report.totals.byTier.review)}`);
  lines.push(`Would have run       ${pad(report.totals.commands - report.totals.paused)}`);
  lines.push(`  warning            ${pad(report.totals.byTier.warning)}`);
  lines.push(`  safe               ${pad(report.totals.byTier.safe)}`);
  lines.push("");
  lines.push("Paused by category");
  const categories = Object.entries(report.pausedByCategory).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (categories.length === 0) lines.push("  (none)");
  else {
    for (const [category, count] of categories) lines.push(`  ${category.padEnd(18)} ${pad(count)}`);
  }
  lines.push("");
  lines.push("Top risky commands");
  if (report.topRisky.length === 0) lines.push("  (none)");
  else {
    for (const row of report.topRisky) {
      lines.push(
        `  ${String(row.count).padStart(3)}  ${row.host.padEnd(12)} ${row.tier.padEnd(12)} ${row.category.padEnd(18)} ${row.command}`,
      );
    }
    const pausedGroups = pausedGroupCount(report);
    if (pausedGroups > report.topRisky.length) {
      lines.push(
        `  Showing ${report.topRisky.length} of ${pausedGroups}. Re-run with --json for every paused command.`,
      );
    }
  }
  lines.push("");
  if (options.verbose) {
    for (const note of report.notes) {
      if (note === DECISION_NOTE) continue;
      lines.push(note);
    }
    lines.push("");
  }
  lines.push(DECISION_NOTE);
  lines.push("");
  lines.push(closingLine(report));
  lines.push("Get a yes/no in Telegram before your agent runs them:");
  lines.push(`  ${report.next}`);
  lines.push("https://oked.ai");
  lines.push("");
  return lines.join("\n");
}

function pausedGroupCount(report: ScanReport): number {
  const keys = new Set<string>();
  for (const row of report.commands) {
    if (!row.paused) continue;
    keys.add(`${row.host}\0${row.tier}\0${row.category}\0${row.command}`);
  }
  return keys.size;
}

export async function scan(options: ScanOptions = {}): Promise<ScanReport> {
  const home = options.home ?? homedir();
  const root = options.root ?? home;
  const explicitRoot = options.explicitRoot ?? false;
  if (explicitRoot && !existsSync(root)) {
    throw new ScanUsageError(`Path not found: ${root}`);
  }
  if (options.sinceDays !== undefined) {
    if (!Number.isInteger(options.sinceDays) || options.sinceDays < 0) {
      throw new ScanUsageError("--since expects a whole number of days (0 or more)");
    }
  }
  const now = options.now ?? new Date();
  const collected = await collectCommands({
    root,
    explicitRoot,
    sinceMs: options.sinceDays === undefined ? null : options.sinceDays * 24 * 60 * 60 * 1000,
    nowMs: now.getTime(),
  });

  const byTier = emptyTiers();
  const byCategory: Record<string, number> = {};
  const pausedByCategory: Record<string, number> = {};
  const commands: CommandRow[] = [];
  const groups = new Map<string, RiskyGroup>();

  for (const raw of collected.commands) {
    const { tier, category } = classifyCommand(raw.host, raw.command);
    const paused = pausesForApproval(tier);
    const command = displayCommand(raw.command, home);
    byTier[tier] += 1;
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    if (paused) pausedByCategory[category] = (pausedByCategory[category] ?? 0) + 1;
    commands.push({
      host: raw.host,
      tier,
      category,
      command,
      paused,
      timestamp: raw.timestamp,
    });
    if (!paused) continue;
    const key = `${raw.host}\0${tier}\0${category}\0${command}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { host: raw.host, tier, category, command, count: 1 });
  }

  const topRisky = [...groups.values()].sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.count - a.count || a.command.localeCompare(b.command),
  );

  const claude = showHost(collected.hosts["claude-code"], home);
  const codex = showHost(collected.hosts.codex, home);
  const paused = byTier.review + byTier.high_stakes;

  return {
    version: packageVersion(),
    classifier: classifierVersion(),
    localOnly: true,
    network: false,
    telemetry: false,
    generatedAt: now.toISOString(),
    sinceDays: options.sinceDays === undefined ? null : options.sinceDays,
    hosts: { "claude-code": claude, codex },
    totals: {
      commands: commands.length,
      paused,
      byTier,
      byCategory,
    },
    pausedByCategory,
    topRisky: topRisky.slice(0, TOP_RISKY),
    commands,
    badLines: collected.badLines,
    unreadableFiles: collected.unreadableFiles,
    notes: NOTES,
    next: nextStep({ claude: claude.present, codex: codex.present }),
  };
}
