#!/usr/bin/env node
/**
 * @oked/openclaw-cli — installer for the @oked/openclaw plugin.
 *
 * Subcommands:
 *   oked-openclaw init       Install the plugin via `openclaw plugins install`,
 *                            persist API key + minTier into ~/.openclaw/openclaw.json,
 *                            and restart the OpenClaw gateway daemon.
 *   oked-openclaw status     Print install state, config, and backend reachability.
 *   oked-openclaw test       Send a test approval request to verify SDK + Telegram.
 *   oked-openclaw uninstall  Remove the OKed entry from openclaw.json and uninstall the plugin.
 */

import { readFile, writeFile, mkdir, access, chmod } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

import { OKedClient } from '@oked/sdk';

const OPENCLAW_DIR = path.join(homedir(), '.openclaw');
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, 'openclaw.json');
const OKED_DIR = path.join(homedir(), '.oked');
const OKED_CONFIG = path.join(OKED_DIR, 'config.json');
const DEFAULT_BACKEND_URL =
  process.env.OKED_BACKEND_URL || 'https://claude-test-project-production.up.railway.app';
const CLIENT_VERSION = '0.1.0';

async function writeOkedConfig(apiKey, backendUrl) {
  await mkdir(OKED_DIR, { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(await readFile(OKED_CONFIG, 'utf8')) || {};
    if (typeof existing !== 'object') existing = {};
  } catch {
    existing = {};
  }
  const payload = { ...existing, apiKey, backendUrl };
  await writeFile(OKED_CONFIG, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  try { await chmod(OKED_CONFIG, 0o600); } catch { /* Windows */ }
}

function openBrowser(url) {
  const plat = platform();
  let cmd;
  let args;
  if (plat === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (plat === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open'; args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best effort */ }
}

async function deviceCodePair() {
  const codeRes = await fetch(`${DEFAULT_BACKEND_URL}/api/v1/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_type: 'openclaw',
      hostname: hostname(),
      client_version: CLIENT_VERSION,
    }),
  });
  if (!codeRes.ok) {
    throw new Error(`Pairing request failed: ${codeRes.status} ${await codeRes.text()}`);
  }
  const code = await codeRes.json();

  console.log('');
  console.log('   To pair this device, open in your browser:');
  console.log(`     ${code.verification_uri_complete}`);
  console.log('');
  console.log(`   Or visit ${code.verification_uri} and enter the code:`);
  console.log(`     ${code.user_code}`);
  console.log('');
  console.log('   Waiting for confirmation...');

  openBrowser(code.verification_uri_complete);

  const deadline = Date.now() + (code.expires_in || 600) * 1000;
  const intervalMs = Math.max(1, code.interval || 3) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollRes = await fetch(`${DEFAULT_BACKEND_URL}/api/v1/device/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: code.device_code }),
    });
    if (pollRes.status === 410) {
      throw new Error('Pairing code expired. Run init again.');
    }
    if (!pollRes.ok) continue;
    const body = await pollRes.json();
    if (body.status === 'approved' && body.api_key) {
      return body.api_key;
    }
  }
  throw new Error('Pairing timed out. Run init again.');
}

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

// ─── plugin path discovery ────────────────────────────────────────────────

async function findPluginPath() {
  // Sibling package in the same monorepo. Walk up from this file looking for
  // packages/openclaw with an openclaw.plugin.json manifest.
  let here = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.resolve(here, '..', 'openclaw');
    if (await fileExists(path.join(candidate, 'openclaw.plugin.json'))) {
      return candidate;
    }
    here = path.dirname(here);
  }
  // Fallback: try to resolve via node_modules of the global install.
  const npmRoot = run('npm', ['root', '-g']);
  if (npmRoot.code === 0) {
    const guess = path.join(npmRoot.stdout, '@oked', 'openclaw');
    if (await fileExists(path.join(guess, 'openclaw.plugin.json'))) return guess;
  }
  return null;
}

// ─── daemon detection ─────────────────────────────────────────────────────

function detectDaemon() {
  if (commandExists('systemctl')) {
    const userUnits = run('systemctl', ['--user', 'list-units', '--type=service', '--no-legend', '--plain']);
    if (userUnits.code === 0) {
      const line = userUnits.stdout.split('\n').find((l) => /openclaw/i.test(l));
      if (line) {
        const unit = line.trim().split(/\s+/)[0];
        return {
          kind: 'systemd-user',
          unit,
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
          kind: 'systemd-system',
          unit,
          label: `systemd unit ${unit} (sudo required)`,
          restartCmd: ['sudo', ['systemctl', 'restart', unit]],
        };
      }
    }
  }
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
  if (commandExists('pgrep')) {
    const pg = run('pgrep', ['-af', 'openclaw']);
    if (pg.code === 0 && pg.stdout) {
      const lines = pg.stdout.split('\n').filter(Boolean);
      const pids = lines.map((l) => l.split(/\s+/)[0]);
      return {
        kind: 'process',
        label: `${pids.length} bare process(es): ${pids.join(', ')}`,
        restartCmd: null,
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

  if (!commandExists('openclaw')) {
    console.error('The "openclaw" command was not found on your PATH.');
    console.error('Install OpenClaw first, then re-run "oked-openclaw init".');
    process.exit(1);
  }

  // 1. Find the plugin source.
  process.stdout.write('1. Locating @oked/openclaw plugin... ');
  const pluginPath = await findPluginPath();
  if (!pluginPath) {
    console.log('failed');
    console.error('\nCould not find a sibling packages/openclaw with openclaw.plugin.json.');
    console.error('If you cloned the monorepo, run this from inside it. Otherwise install');
    console.error('@oked/openclaw globally first:  npm install -g @oked/openclaw\n');
    process.exit(1);
  }
  console.log('found');
  console.log(`   Path: ${pluginPath}\n`);

  // 2. Register the plugin with OpenClaw.
  console.log('2. Installing into OpenClaw...');
  const installArgs = ['plugins', 'install', '--link', pluginPath];
  console.log(`   $ openclaw ${installArgs.join(' ')}`);
  const installCode = await runStreaming('openclaw', installArgs);
  if (installCode !== 0) {
    console.error(`\n   ✗ openclaw plugins install exited ${installCode}.`);
    process.exit(installCode);
  }
  console.log('');

  // 3. API key — reuse existing if present, otherwise pair this device.
  const existing = await readConfig();
  const existingEntry = existing?.plugins?.entries?.oked || {};
  let apiKey = process.env.OKED_API_KEY || existingEntry.apiKey || '';
  if (apiKey) {
    console.log(`3. Using existing API key: ${maskKey(apiKey)}`);
  } else {
    console.log('3. Pairing this device with OKed...');
    try {
      apiKey = await deviceCodePair();
      console.log(`   Paired. API key: ${maskKey(apiKey)}`);
      await writeOkedConfig(apiKey, DEFAULT_BACKEND_URL);
      console.log(`   Saved to ${OKED_CONFIG}`);
    } catch (err) {
      console.error(`   ${err.message}`);
      process.exit(1);
    }
  }

  let minTier = process.env.OKED_MIN_TIER || existingEntry.minTier || '';
  if (!minTier && process.stdin.isTTY) {
    const a = await prompt(`   minTier (review|warning|high_stakes) [review]: `);
    minTier = (a || 'review').toLowerCase();
  }
  if (!['review', 'warning', 'high_stakes', 'safe'].includes(minTier)) {
    minTier = 'review';
  }

  // 4. Update openclaw.json — apiKey/minTier are now declared in the plugin's
  //    configSchema, so OpenClaw 2026.5+ will accept them under entries.oked.
  process.stdout.write('4. Updating ~/.openclaw/openclaw.json... ');
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
    minTier,
  };
  await writeConfig(cfg);
  console.log('done');
  console.log(`   File: ${OPENCLAW_CONFIG}\n`);

  // 5. Restart the daemon.
  console.log('5. Detecting OpenClaw process...');
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
  const entry = cfg?.plugins?.entries?.oked || {};
  const allowed = Array.isArray(cfg?.plugins?.allow) && cfg.plugins.allow.includes('oked');
  const apiKey = entry.apiKey || process.env.OKED_API_KEY || '';

  console.log(`Config file   : ${OPENCLAW_CONFIG}`);
  console.log(`Plugin allowed: ${allowed ? 'yes' : 'no'}`);
  console.log(`Plugin enabled: ${entry.enabled ? 'yes' : 'no'}`);
  console.log(`API key       : ${maskKey(apiKey)}`);
  console.log(`minTier       : ${entry.minTier || '(default warning)'}`);

  if (commandExists('openclaw')) {
    const r = run('openclaw', ['plugins', 'list']);
    const installed = /\boked\b/.test(r.stdout) && !/\boked\b.*not\s+found/i.test(r.stdout);
    console.log(`Plugin installed: ${installed ? 'yes' : 'no — run "oked-openclaw init"'}`);
  }

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

async function cmdUninstall() {
  let cfg;
  try {
    await access(OPENCLAW_CONFIG);
    cfg = await readConfig();
  } catch {
    console.log('No openclaw.json found — nothing to remove.');
  }

  if (cfg) {
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
    if (changed) {
      await writeConfig(cfg);
      console.log(`✓ Removed OKed entry from ${OPENCLAW_CONFIG}`);
    } else {
      console.log('No OKed entry was present in openclaw.json.');
    }
  }

  if (commandExists('openclaw')) {
    console.log('Running: openclaw plugins uninstall oked');
    await runStreaming('openclaw', ['plugins', 'uninstall', 'oked']);
  }
  console.log('  Restart the OpenClaw daemon to fully unload the plugin.');
}

function usage() {
  console.log(`oked-openclaw — installer for the @oked/openclaw plugin

Usage:
  oked-openclaw init        Install the plugin and configure openclaw.json
  oked-openclaw status      Show install state + backend reachability
  oked-openclaw uninstall   Remove the OKed entry and uninstall the plugin
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
