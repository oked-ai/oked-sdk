#!/usr/bin/env node
/**
 * OKed — Claude Code CLI
 *
 * Subcommands:
 *   oked init        Install the PreToolUse hook into ~/.claude/settings.json
 *   oked status      Print current install state + backend reachability
 *   oked uninstall   Remove the OKed hook from ~/.claude/settings.json
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { OKedClient } from '@oked/sdk';

const HOOK_PATH = fileURLToPath(new URL('../hook.mjs', import.meta.url));
const SETTINGS_DIR = path.join(homedir(), '.claude');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function maskKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function readSettings() {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not parse ${SETTINGS_FILE}: ${err.message}`);
  }
}

async function writeSettings(settings) {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function isOkedHookEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => typeof h?.command === 'string' && h.command.includes('hook.mjs') && h.command.toLowerCase().includes('oked')
  );
}

function buildOkedEntry() {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `node "${HOOK_PATH}"`,
      },
    ],
  };
}

async function cmdInit() {
  const settings = await readSettings();

  let apiKey = process.env.OKED_API_KEY || settings?.env?.OKED_API_KEY || '';
  if (!apiKey) {
    const rl = readline.createInterface({ input, output });
    apiKey = (await rl.question('OKED_API_KEY: ')).trim();
    rl.close();
    if (!apiKey) {
      console.error('No API key provided. Aborting.');
      process.exit(1);
    }
  }

  settings.env = { ...(settings.env || {}), OKED_API_KEY: apiKey };

  settings.hooks = settings.hooks || {};
  const preToolUse = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  const filtered = preToolUse.filter((entry) => !isOkedHookEntry(entry));
  filtered.push(buildOkedEntry());
  settings.hooks.PreToolUse = filtered;

  await writeSettings(settings);

  const client = new OKedClient({ apiKey });
  console.log(`\n✓ OKed hook installed at ${SETTINGS_FILE}`);
  console.log(`  Hook script : ${HOOK_PATH}`);
  console.log(`  API key     : ${maskKey(apiKey)}`);
  console.log(`  Dashboard   : ${client.backendUrl}/dashboard`);
  console.log('\nOpen a new Claude Code session to activate.\n');
}

async function cmdStatus() {
  const settings = await readSettings().catch(() => ({}));
  const preToolUse = settings?.hooks?.PreToolUse || [];
  const installed = preToolUse.some(isOkedHookEntry);
  const apiKey = settings?.env?.OKED_API_KEY || process.env.OKED_API_KEY || '';

  console.log(`Settings file : ${SETTINGS_FILE}`);
  console.log(`Hook installed: ${installed ? 'yes' : 'no'}`);
  console.log(`Hook script   : ${HOOK_PATH}`);
  console.log(`API key       : ${maskKey(apiKey)}`);

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
  let settings;
  try {
    await access(SETTINGS_FILE);
    settings = await readSettings();
  } catch {
    console.log('No settings file found — nothing to remove.');
    return;
  }

  const preToolUse = settings?.hooks?.PreToolUse || [];
  const filtered = preToolUse.filter((entry) => !isOkedHookEntry(entry));

  if (filtered.length === preToolUse.length) {
    console.log('No OKed hook entry was present.');
    return;
  }

  settings.hooks = settings.hooks || {};
  if (filtered.length === 0) {
    delete settings.hooks.PreToolUse;
  } else {
    settings.hooks.PreToolUse = filtered;
  }

  await writeSettings(settings);
  console.log(`✓ Removed OKed hook from ${SETTINGS_FILE}`);
}

function usage() {
  console.log(`oked — Claude Code human approval hook

Usage:
  oked init        Install the PreToolUse hook
  oked status      Show current install state
  oked uninstall   Remove the hook
  oked help        Show this message
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
  console.error(`oked: ${err.message}`);
  process.exit(1);
});
