#!/usr/bin/env node
/**
 * @oked/openclaw — installer CLI
 *
 * Subcommands:
 *   oked-openclaw init        Install the OKed plugin into ~/.openclaw/openclaw.json
 *                             and offer to restart the OpenClaw daemon.
 *   oked-openclaw status      Print current install state + backend reachability
 *   oked-openclaw uninstall   Remove the OKed entry from ~/.openclaw/openclaw.json
 *   oked-openclaw test        Send a test approval request via the OKed SDK
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

import { OKedClient } from '@oked/sdk';

const OPENCLAW_DIR = path.join(homedir(), '.openclaw');
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, 'openclaw.json');

// ─── helpers ──────────────────────────────────────────────────────────────

function maskKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
}

function commandExists(cmd) {
  const probe = platform() === 'win32' ? 'where' : 'which';
  return run(probe, [cmd]).code === 0;
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readConfig() {
  try {
    const raw = await readFile(OPENCLAW_CONFIG, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not parse ${OPENCLAW_CONFIG}: ${err.message}`);
  }
}

async function writeConfig(cfg) {
  await mkdir(OPENCLAW_DIR, { recursive: true });
  await writeFile(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

async function prompt(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input, output });
  const a = await rl.question(question);
  rl.close();
  return a.trim();
}

async function confirm(question, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const a = (await prompt(question + suffix)).toLowerCase();
  if (!a) return defaultYes;
  return a === 'y' || a === 'yes';
}

function runStreaming(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', (err) => {
      console.error(`  Failed to spawn ${cmd}: ${err.message}`);
      resolve(-1);
    });
  });
}

// ─── plugin install detection ─────────────────────────────────────────────

async function ensurePluginInstalled() {
  // 1. Find npm's global root.
  const npmRoot = run('npm', ['root', '-g']);
  if (npmRoot.code !== 0) {
    return { ok: false, reason: 'Could not run "npm root -g". Is npm on your PATH?' };
  }
  const globalRoot = npmRoot.stdout;
  const pluginPath = path.join(globalRoot, '@oked', 'openclaw');

  if (await fileExists(pluginPath)) {
    return { ok: true, path: pluginPath, alreadyInstalled: true };
  }

  // 2. We're already running from the plugin source. If this CLI is being
  //    executed from a clone, link the plugin globally so OpenClaw can find it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(here, '..'); // packages/openclaw
  if (await fileExists(path.join(pluginRoot, 'package.json'))) {
    const linkSrc = run('npm', ['link'], { cwd: pluginRoot });
    if (linkSrc.code !== 0) {
      return { ok: false, reason: `npm link failed in ${pluginRoot}:\n${linkSrc.stderr}` };
    }
    return { ok: true, path: pluginPath, linked: true };
  }

  return {
    ok: false,
    reason:
      `@oked/openclaw is not installed at ${pluginPath} and the plugin source\n` +
      `was not found relative to this CLI (${pluginRoot}).\n` +
      `Install it with: npm install -g @oked/openclaw`,
  };
}

// ─── daemon detection ─────────────────────────────────────────────────────

function detectDaemon() {
  // systemd --user
  if (commandExists('systemctl')) {
    const userUnits = run('systemctl', ['--user', 'list-units', '--type=service', '--no-legend', '--plain']);
    if (userUnits.code === 0) {
      const line = userUnits.stdout.split('\n').find((l) => /openclaw/i.test(l));
      if (line) {
        const unit = line.trim().split(/\s+/)[0];
        return {
          kind: 'systemd-user',
          label: `systemd --user unit ${unit}`,
          restartCmd: ['systemctl', ['--user', 'restart', unit]],
        };
      }
    }
    const sysUnits = run('systemctl', ['list-units', '--type=service', '--no-legend', '--plain']);
    if (sysUnits.code === 0) {
      const line = sysUnits.stdout.split('\n').find((l) => /openclaw/i.test(l));
      if (line) {
        const unit = line.trim().split(/\s+/)[0];
        return {
          kind: 'systemd',
          label: `systemd unit ${unit} (sudo required)`,
          restartCmd: ['sudo', ['systemctl', 'restart', unit]],
        };
      }
    }
  }
  // pm2
  if (commandExists('pm2')) {
    const list = run('pm2', ['jlist']);
    if (list.code === 0 && /openclaw/i.test(list.stdout)) {
      try {
        const procs = JSON.parse(list.stdout);
        const proc = procs.find((p) => /openclaw/i.test(p.name || ''));
        if (proc) return { kind: 'pm2', label: `pm2 process ${proc.name}`, restartCmd: ['pm2', ['restart', proc.name]] };
      } catch { /* ignore */ }
    }
  }
  // launchd (macOS)
  if (platform() === 'darwin' && commandExists('launchctl')) {
    const list = run('launchctl', ['list']);
    if (list.code === 0) {
      const line = list.stdout.split('\n').find((l) => /openclaw/i.test(l));
      if (line) {
        const label = line.trim().split(/\s+/).pop();
        return {
          kind: 'launchd',
          label: `launchd job ${label}`,
          restartCmd: ['launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]],
        };
      }
    }
  }
  // Bare process
  if (commandExists('pgrep')) {
    const pg = run('pgrep', ['-af', 'openclaw']);
    if (pg.code === 0 && pg.stdout) {
      const lines = pg.stdout.split('\n').filter(Boolean);
      const pids = lines.map((l) => l.split(/\s+/)[0]);
      return {
        kind: 'process',
        label: `${pids.length} bare process(es): ${pids.join(', ')}`,
        restartCmd: null, // can't safely auto-relaunch
        pids,
        commands: lines.map((l) => l.split(/\s+/).slice(1).join(' ')),
      };
    }
  }
  return null;
}

// ─── commands ─────────────────────────────────────────────────────────────

async function cmdInit() {
  console.log('\nOKed → OpenClaw plugin installer\n');

  // 1. Plugin reachable from OpenClaw's module resolver.
  process.stdout.write('1. Locating @oked/openclaw plugin... ');
  const install = await ensurePluginInstalled();
  if (!install.ok) {
    console.log('failed');
    console.error(`\n${install.reason}\n`);
    process.exit(1);
  }
  console.log(install.alreadyInstalled ? 'already installed' : 'linked');
  console.log(`   Path: ${install.path}\n`);

  // 2. API key.
  const existing = await readConfig();
  let apiKey = process.env.OKED_API_KEY || existing?.plugins?.entries?.oked?.apiKey || '';
  if (!apiKey) {
    if (!process.stdin.isTTY) {
      console.error('OKED_API_KEY not set and stdin is not interactive. Aborting.');
      process.exit(1);
    }
    apiKey = await prompt('2. OKED_API_KEY: ');
    if (!apiKey) {
      console.error('No API key provided. Aborting.');
      process.exit(1);
    }
  } else {
    console.log(`2. Using API key: ${maskKey(apiKey)}`);
  }

  // 3. Merge openclaw.json (preserve other fields).
  process.stdout.write('3. Updating ~/.openclaw/openclaw.json... ');
  const cfg = existing && typeof existing === 'object' ? existing : {};
  cfg.plugins = cfg.plugins || {};
  const allow = Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow : [];
  if (!allow.includes('oked')) allow.push('oked');
  cfg.plugins.allow = allow;
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries.oked = {
    ...(cfg.plugins.entries.oked || {}),
    enabled: true,
    apiKey,
    minTier: cfg.plugins.entries.oked?.minTier || 'review',
  };
  await writeConfig(cfg);
  console.log('done');
  console.log(`   File: ${OPENCLAW_CONFIG}\n`);

  // 4. Restart the daemon.
  console.log('4. Detecting OpenClaw process...');
  const daemon = detectDaemon();
  if (!daemon) {
    console.log('   No running OpenClaw process found.');
    console.log('   Start (or restart) OpenClaw the way you normally do, then run "oked-openclaw test".\n');
    return;
  }
  console.log(`   Found: ${daemon.label}`);

  if (!daemon.restartCmd) {
    console.log('\n   Bare processes can be stopped but not safely auto-relaunched.');
    if (daemon.commands?.length) {
      console.log('   Commands currently running:');
      daemon.commands.forEach((c) => console.log(`     ${c}`));
    }
    const ok = await confirm('   Send SIGTERM to the process(es) above?', false);
    if (ok) {
      for (const pid of daemon.pids) {
        const r = run('kill', [pid]);
        console.log(`     kill ${pid}: ${r.code === 0 ? 'sent' : `failed (${r.stderr})`}`);
      }
      console.log('\n   Now relaunch OpenClaw the same way you started it, then run "oked-openclaw test".\n');
    } else {
      console.log('   Skipped. Restart OpenClaw manually, then run "oked-openclaw test".\n');
    }
    return;
  }

  const [cmd, args] = daemon.restartCmd;
  const cmdline = `${cmd} ${args.join(' ')}`;
  const ok = await confirm(`\n   Run: ${cmdline} ?`, true);
  if (!ok) {
    console.log(`   Skipped. To restart manually:  ${cmdline}\n`);
    return;
  }
  console.log(`\n   $ ${cmdline}`);
  const code = await runStreaming(cmd, args);
  if (code === 0) {
    console.log('\n   ✓ Restart command exited 0.');
    console.log('   Run "oked-openclaw test" or trigger a real OpenClaw tool call to verify.\n');
  } else {
    console.log(`\n   ✗ Restart command exited ${code}. Restart OpenClaw manually and try again.\n`);
    process.exit(code);
  }
}

async function cmdStatus() {
  const cfg = await readConfig().catch(() => ({}));
  const entry = cfg?.plugins?.entries?.oked;
  const allowed = Array.isArray(cfg?.plugins?.allow) && cfg.plugins.allow.includes('oked');
  const apiKey = entry?.apiKey || process.env.OKED_API_KEY || '';

  console.log(`Config file   : ${OPENCLAW_CONFIG}`);
  console.log(`Plugin allowed: ${allowed ? 'yes' : 'no'}`);
  console.log(`Plugin enabled: ${entry?.enabled ? 'yes' : 'no'}`);
  console.log(`API key       : ${maskKey(apiKey)}`);
  console.log(`minTier       : ${entry?.minTier || '(default)'}`);

  const daemon = detectDaemon();
  console.log(`Daemon        : ${daemon ? daemon.label : 'not detected'}`);

  const client = new OKedClient({ apiKey });
  console.log(`Backend URL   : ${client.backendUrl}`);
  try {
    const ok = await client.ping();
    console.log(`Backend reach : ${ok ? 'ok' : 'unreachable'}`);
  } catch (err) {
    console.log(`Backend reach : error — ${err.message}`);
  }
}

async function cmdUninstall() {
  let cfg;
  try {
    await access(OPENCLAW_CONFIG);
    cfg = await readConfig();
  } catch {
    console.log('No openclaw.json found — nothing to remove.');
    return;
  }

  let changed = false;
  if (Array.isArray(cfg?.plugins?.allow)) {
    const filtered = cfg.plugins.allow.filter((n) => n !== 'oked');
    if (filtered.length !== cfg.plugins.allow.length) {
      cfg.plugins.allow = filtered;
      changed = true;
    }
  }
  if (cfg?.plugins?.entries?.oked) {
    delete cfg.plugins.entries.oked;
    changed = true;
  }

  if (!changed) {
    console.log('No OKed entry was present in openclaw.json.');
    return;
  }
  await writeConfig(cfg);
  console.log(`✓ Removed OKed entry from ${OPENCLAW_CONFIG}`);
  console.log('  Restart the OpenClaw daemon to fully unload the plugin.');
}

async function cmdTest() {
  const cfg = await readConfig().catch(() => ({}));
  const apiKey = cfg?.plugins?.entries?.oked?.apiKey || process.env.OKED_API_KEY || '';

  if (!apiKey) {
    console.error('No API key found. Run "oked-openclaw init" first.');
    process.exit(1);
  }

  const client = new OKedClient({ apiKey });

  console.log('');
  console.log('Sending test approval request...');
  console.log(`  Dashboard: ${client.backendUrl}/dashboard`);
  console.log('');
  console.log('  Approve or deny it from your dashboard or Telegram.');
  console.log('  Waiting...');
  console.log('');

  try {
    const result = await client.approve({
      action: 'oked-openclaw-test',
      description: 'Test approval from "oked-openclaw test" — approve or deny to verify your setup works.',
      tier: 'high_stakes',
      session_id: `openclaw-test-${Date.now()}`,
      cwd: process.cwd(),
    });

    if (result.approved) {
      console.log('  ✓ Approved! OKed is working end-to-end.\n');
      console.log('  Note: this only verifies the SDK + backend + Telegram path.');
      console.log('  Trigger a real OpenClaw tool call to confirm the plugin is loaded.\n');
    } else {
      console.log(`  ✗ ${result.decision}. OKed is working — the request was ${result.decision}.\n`);
    }
  } catch (err) {
    console.error(`  Error: ${err.message}\n`);
    process.exit(1);
  }
}

function usage() {
  console.log(`oked-openclaw — OKed plugin installer for OpenClaw

Usage:
  oked-openclaw init        Install the plugin and offer to restart the daemon
  oked-openclaw status      Show current install state + backend reachability
  oked-openclaw uninstall   Remove the OKed entry from openclaw.json
  oked-openclaw test        Send a test approval request via the OKed SDK
  oked-openclaw help        Show this message
`);
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'init':
      await cmdInit();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'uninstall':
      await cmdUninstall();
      break;
    case 'test':
      await cmdTest();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`oked-openclaw: ${err.message}`);
  process.exit(1);
});
