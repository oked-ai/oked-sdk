import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, describeFields } from "@oked/sdk";
import {
  SHELL_TOOL_NAMES,
  argvToShell,
  classifyCommand,
  collectCommands,
  displayCommand,
  formatReport,
  nextStep,
  redactSecrets,
  scan,
  ScanUsageError,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const fixtureHome = fileURLToPath(new URL("./fixtures/home", import.meta.url));
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = new Date("2026-10-31T00:00:00.000Z");

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

function sorted(commands: string[]): string[] {
  return [...commands].sort();
}

describe("redaction", () => {
  it("redacts token shapes and keeps the rest of the command", () => {
    const command = [
      `curl -X POST https://example.com/hook -H "Authorization: Bearer ${SECRET}" -d hi`,
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11AAAAAAA0123456789abcdef",
      "AKIAIOSFODNN7EXAMPLE",
      "https://user:p@ssw0rd@example.com/x",
      "API_KEY=supersecret",
      "--token s3cr3t",
    ].join(" ");
    const redacted = redactSecrets(command);
    assert.equal(redacted.includes(SECRET), false);
    assert.equal(redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false);
    assert.equal(redacted.includes("github_pat_11AAAAAAA0123456789abcdef"), false);
    assert.equal(redacted.includes("AKIAIOSFODNN7EXAMPLE"), false);
    assert.equal(redacted.includes("p@ssw0rd"), false);
    assert.equal(redacted.includes("supersecret"), false);
    assert.equal(redacted.includes("s3cr3t"), false);
    assert.match(redacted, /Bearer \[redacted\]/);
    assert.match(redacted, /https:\/\/example\.com\/hook/);
    assert.match(redacted, /https:\/\/\[redacted\]@example\.com\/x/);
    assert.equal(redacted.includes("@ssw0rd"), false);
    assert.match(redacted, /API_KEY=\[redacted\]/);
  });

  it("does not redact a git object id", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(redactSecrets(`git checkout ${sha}`), `git checkout ${sha}`);
  });

  it("replaces the home directory and truncates after redaction", () => {
    const home = "/Users/ada";
    const shown = displayCommand(`rm -rf ${home}/secrets && echo ${"x".repeat(200)}`, home);
    assert.equal(shown.startsWith("rm -rf ~/secrets"), true);
    assert.equal(shown.includes("/Users/ada"), false);
    assert.equal(shown.endsWith("..."), true);
    assert.equal(shown.length, 120);
  });

  it("joins Codex argv so a bash -lc script stays one command", () => {
    assert.equal(
      argvToShell(["bash", "-lc", "curl -X POST https://example.com/hook -d hi"]),
      "bash -lc 'curl -X POST https://example.com/hook -d hi'",
    );
    assert.equal(argvToShell(["rm", "-rf", "/var/data"]), "rm -rf /var/data");
  });
});

describe("classifyCommand uses the hook classifier", () => {
  const samples = ["ls", "npm test", "rm -rf /var/data", "git push --force origin main", "vercel --prod", "git commit -m wip"];

  for (const host of ["claude-code", "codex"] as const) {
    for (const command of samples) {
      it(`${host} ${command}`, () => {
        const options = host === "claude-code" ? { sandboxEnforced: false as const } : undefined;
        const got = classifyCommand(host, command);
        assert.equal(got.tier, classify("Bash", { command }, options));
        assert.equal(got.category, describeFields("Bash", { command }, options ?? {})?.Kind);
      });
    }
  }

  it("pauses npm test on Claude Code and not on Codex", () => {
    assert.equal(classifyCommand("claude-code", "npm test").tier, "review");
    assert.equal(classifyCommand("codex", "npm test").tier, "safe");
  });
});

describe("fixture transcripts", () => {
  it("reads Bash calls and Codex shell calls, and skips everything else", async () => {
    const collected = await collectCommands({
      root: fixtureHome,
      explicitRoot: true,
      sinceMs: null,
      nowMs: NOW.getTime(),
    });
    const claude = sorted(collected.commands.filter((command) => command.host === "claude-code").map((command) => command.command));
    const codex = sorted(collected.commands.filter((command) => command.host === "codex").map((command) => command.command));
    assert.deepEqual(claude, sorted([
      "ls",
      "rm -rf /var/data",
      "git push --force origin main",
      `curl -X POST https://example.com/hook -H "Authorization: Bearer ${SECRET}" -d hi`,
      'git commit -m "wip"',
      "npm test",
      "rm -rf /etc/old",
      "vercel --prod",
      "git push --force origin other",
    ]));
    assert.deepEqual(codex, sorted([
      "git status",
      "git status",
      "rm -rf /var/data",
      "bash -lc 'curl -X POST https://example.com/hook -d hi'",
      "npm test",
      "vercel --prod",
      "git commit -m wip",
    ]));
    assert.equal(collected.commands.some((command) => command.command === "rm -rf /"), false);
    assert.equal(collected.hosts["claude-code"].files, 2);
    assert.equal(collected.hosts.codex.files, 2);
    assert.equal(collected.badLines, 1);
  });

  it("drops commands older than --since and keeps undated ones", async () => {
    const report = await scan({
      root: fixtureHome,
      explicitRoot: true,
      home: fixtureHome,
      sinceDays: 7,
      now: NOW,
    });
    assert.equal(report.commands.some((command) => command.command.includes("/etc/old")), false);
    assert.equal(report.commands.some((command) => command.command === "vercel --prod" && command.host === "claude-code"), true);
    assert.equal(report.sinceDays, 7);
  });

  it("matches classify() for every fixture command and redacts secrets in the report", async () => {
    const report = await scan({
      root: fixtureHome,
      explicitRoot: true,
      home: fixtureHome,
      now: NOW,
    });
    const collected = await collectCommands({
      root: fixtureHome,
      explicitRoot: true,
      sinceMs: null,
      nowMs: NOW.getTime(),
    });
    assert.equal(report.commands.length, collected.commands.length);
    assert.equal(report.localOnly, true);
    assert.equal(report.network, false);
    assert.equal(report.telemetry, false);
    for (const raw of collected.commands) {
      const classified = classifyCommand(raw.host, raw.command);
      const row = report.commands.find(
        (command) => command.host === raw.host && command.command === displayCommand(raw.command, fixtureHome) && command.tier === classified.tier,
      );
      assert.ok(row, raw.command);
      assert.equal(row.category, classified.category);
      assert.equal(row.paused, classified.tier === "review" || classified.tier === "high_stakes");
    }
    const blob = JSON.stringify(report);
    assert.equal(blob.includes(SECRET), false);
    assert.equal(blob.includes("\u2014"), false);
    assert.equal(blob.includes("backendUrl"), false);
    assert.equal(blob.includes("OKED_BACKEND_URL"), false);
    const claudeTest = report.commands.find((command) => command.host === "claude-code" && command.command === "npm test");
    const codexTest = report.commands.find((command) => command.host === "codex" && command.command === "npm test");
    assert.equal(claudeTest?.paused, true);
    assert.equal(codexTest?.paused, false);
    assert.equal(report.totals.paused, report.totals.byTier.review + report.totals.byTier.high_stakes);
    assert.equal(report.next, nextStep({ claude: true, codex: true }));

    const text = formatReport(report);
    assert.match(text, /Local only\. This scan does not use the network and does not send telemetry\./);
    assert.match(text, /Would have paused/);
    assert.match(text, /high_stakes/);
    assert.match(text, /Next: npm install -g @oked\/claude-code @oked\/codex && oked init && oked-codex init/);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes("\u2014"), false);
    assert.match(text, /The iPhone app is coming soon/);
    assert.match(text, /https:\/\/oked\.ai\/dashboard/);
  });

  it("accepts a projects directory or a sessions directory as --path", async () => {
    const projects = join(fixtureHome, ".claude", "projects");
    const sessions = join(fixtureHome, ".codex", "sessions");
    const claudeOnly = await scan({ root: projects, explicitRoot: true, home: fixtureHome, now: NOW });
    assert.equal(claudeOnly.hosts["claude-code"].commands, 9);
    assert.equal(claudeOnly.hosts.codex.present, false);
    assert.equal(claudeOnly.next, "npm install -g @oked/claude-code && oked init");
    const codexOnly = await scan({ root: sessions, explicitRoot: true, home: fixtureHome, now: NOW });
    assert.equal(codexOnly.hosts.codex.commands, 7);
    assert.equal(codexOnly.hosts["claude-code"].present, false);
    assert.equal(codexOnly.next, "npm install -g @oked/codex && oked-codex init");
  });

  it("matches the sample printed in the README", async () => {
    const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
    const marker = readme.indexOf("<!-- fixture-report -->");
    assert.ok(marker > 0);
    const open = readme.indexOf("```\n", marker);
    const close = readme.indexOf("\n```", open + 4);
    const sample = readme.slice(open + 4, close + 1);
    const report = await scan({ root: fixtureHome, explicitRoot: true, home: fixtureHome, now: NOW });
    assert.equal(sample, formatReport(report));
  });
});

describe("missing directories", () => {
  it("reports an empty home without throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "oked-scan-empty-"));
    const report = await scan({ root, explicitRoot: false, home: root, now: NOW });
    assert.equal(report.hosts["claude-code"].present, false);
    assert.equal(report.hosts.codex.present, false);
    assert.equal(report.totals.commands, 0);
    assert.equal(report.next, "npm install -g @oked/claude-code && oked init");
    assert.match(formatReport(report), /no transcripts at ~\/\.claude\/projects/);
    assert.match(formatReport(report), /no sessions at ~\/\.codex\/sessions/);
  });

  it("rejects a --path that does not exist", async () => {
    await assert.rejects(
      () => scan({ root: join(tmpdir(), "oked-scan-missing", "nope"), explicitRoot: true }),
      ScanUsageError,
    );
  });
});

describe("shell tool names stay aligned with the Codex hook", () => {
  it("includes every name in packages/codex/src/map.ts", () => {
    const mapSrc = readFileSync(fileURLToPath(new URL("../../codex/src/map.ts", import.meta.url)), "utf8");
    const start = mapSrc.indexOf("const SHELL_NAMES");
    const end = mapSrc.indexOf("]);", start);
    const names = [...mapSrc.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(names.length >= 5);
    for (const name of names) assert.equal(SHELL_TOOL_NAMES.has(name), true, name);
    assert.equal(SHELL_TOOL_NAMES.has("Bash"), true);
  });
});

describe("package wiring", () => {
  it("is lockstep with @oked/sdk and listed for publish", () => {
    const scanPkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    const sdkPkg = JSON.parse(readFileSync(join(repoRoot, "packages/sdk/package.json"), "utf8")) as { version: string };
    assert.equal(scanPkg.version, sdkPkg.version);
    assert.equal(scanPkg.dependencies["@oked/sdk"], sdkPkg.version);
    const publish = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
    assert.match(publish, /\n\s+- scan\n/);
    const releasing = readFileSync(join(repoRoot, "RELEASING.md"), "utf8");
    assert.match(releasing, /`scan`/);
    const hosts = readFileSync(join(repoRoot, "docs/hosts.md"), "utf8");
    assert.match(hosts, /@oked\/scan/);
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.match(readme, /@oked\/scan/);
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /@oked\/scan/);
  });
});

describe("source does not use a network module", () => {
  it("has no network import, no fetch call, no backend URL, and no em dash", () => {
    const files = walk(join(pkgRoot, "src")).concat(join(pkgRoot, "README.md"));
    const network = /(?:import|from|require\()\s*["'](?:node:)?(?:http|https|net|dns|tls|dgram)["']|from\s+["']undici["']|\bfetch\s*\(/;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(network.test(text), false, file);
      assert.equal(text.includes("\u2014"), false, file);
      assert.equal(text.includes("backendUrl"), false, file);
      assert.equal(text.includes("OKED_BACKEND_URL"), false, file);
      const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      for (const email of emails) assert.equal(email, "contact@oked.ai", file);
      if (text.includes("iPhone")) assert.match(text, /coming soon/);
    }
  });
});

describe("cli", () => {
  const tsx = require.resolve("tsx/cli");
  const cli = join(pkgRoot, "src/cli.ts");

  function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: pkgRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("prints help", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--since/);
    assert.match(result.stdout, /--path/);
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /does not use the network/);
  });

  it("rejects a bad --since and a missing --path", () => {
    assert.equal(run(["--since", "nope"]).status, 1);
    assert.equal(run(["--path", join(tmpdir(), "oked-scan-cli-missing")]).status, 1);
  });

  it("prints JSON for the fixtures and stays quiet when the home has no transcripts", () => {
    const scanned = run(["--path", fixtureHome, "--json", "--since", "7"]);
    assert.equal(scanned.status, 0, scanned.stderr);
    const report = JSON.parse(scanned.stdout) as { network: boolean; commands: { command: string }[]; next: string };
    assert.equal(report.network, false);
    assert.equal(JSON.stringify(report).includes(SECRET), false);
    assert.match(report.next, /oked init/);

    const empty = mkdtempSync(join(tmpdir(), "oked-scan-home-"));
    const quiet = run([], { HOME: empty });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.match(quiet.stdout, /no transcripts/);
    assert.match(quiet.stdout, /Next: npm install -g @oked\/claude-code && oked init/);
    assert.equal(quiet.stdout.includes("\u2014"), false);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|js|mjs|md)$/.test(entry.name)) out.push(path);
  }
  return out;
}
