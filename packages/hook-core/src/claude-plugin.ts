import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  claudeUserSettingsPath,
  commandIsResolvable,
  listClaudeOkedCommands,
  matcherCoversTool,
} from "./claude-hooks.js";

/** Marketplace and manifest name for the Claude Code plugin. */
export const OKED_PLUGIN_NAME = "oked";

/** Hook file the plugin runs. Settings stand down only when this file is installed. */
export const OKED_PLUGIN_HOOK_FILE = join("scripts", "oked-hook.mjs");

export interface OkedInstallRecord {
  id: string;
  installPath?: string;
}

export interface OkedPluginResolution {
  enabled: boolean;
  id?: string;
}

/** `oked`, `oked@oked`, `oked@inline`, and any other `oked@...` id. */
export function isOkedPluginId(id: string): boolean {
  return id === OKED_PLUGIN_NAME || id.startsWith(`${OKED_PLUGIN_NAME}@`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Directories that can hold `installed_plugins.json`.
 * Claude Code keeps plugins under `~/.claude/plugins` unless
 * `CLAUDE_CODE_PLUGIN_CACHE_DIR` is set. `CLAUDE_CONFIG_DIR` moves settings,
 * and some installs keep plugins beside those settings, so both are checked.
 */
export function claudePluginsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  const add = (dir: string) => {
    if (!dirs.includes(dir)) dirs.push(dir);
  };
  if (env.CLAUDE_CODE_PLUGIN_CACHE_DIR) add(env.CLAUDE_CODE_PLUGIN_CACHE_DIR);
  const config = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  add(join(config, "plugins"));
  add(join(env.HOME || homedir(), ".claude", "plugins"));
  return dirs;
}

/** OKed rows from an `installed_plugins.json` document. */
export function installedOkedRecords(doc: unknown): OkedInstallRecord[] {
  if (!doc || typeof doc !== "object") return [];
  const plugins = (doc as { plugins?: unknown }).plugins;
  const records: OkedInstallRecord[] = [];
  const push = (id: string, value: unknown) => {
    if (!isOkedPluginId(id)) return;
    const entries = Array.isArray(value) ? value : [value];
    let pushed = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const installPath = (entry as { installPath?: unknown }).installPath;
      records.push({
        id,
        ...(typeof installPath === "string" && installPath ? { installPath } : {}),
      });
      pushed = true;
    }
    if (!pushed) records.push({ id });
  };
  if (Array.isArray(plugins)) {
    for (const entry of plugins) {
      if (!entry || typeof entry !== "object") continue;
      const raw = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
      if (typeof raw === "string") push(raw, entry);
    }
    return records;
  }
  if (plugins && typeof plugins === "object") {
    for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) push(id, value);
  }
  return records;
}

/**
 * Merge OKed `enabledPlugins` flags. `layersLowToHigh` is user, then project,
 * then local. A higher layer that sets true or false wins for that id.
 * An installed id with no flag is enabled, because the plugin's
 * `defaultEnabled` is true.
 */
export function resolveOkedPluginEnabled(
  installedIds: string[],
  layersLowToHigh: unknown[],
): OkedPluginResolution {
  const ids = new Set<string>();
  for (const id of installedIds) if (isOkedPluginId(id)) ids.add(id);
  const maps = layersLowToHigh.map(enabledMap);
  for (const map of maps) {
    if (!map) continue;
    for (const id of Object.keys(map)) if (isOkedPluginId(id)) ids.add(id);
  }
  let enabledId: string | undefined;
  for (const id of ids) {
    let mentioned = false;
    let value = false;
    for (const map of maps) {
      if (!map || !Object.prototype.hasOwnProperty.call(map, id)) continue;
      const flag = map[id];
      if (flag === true || flag === false) {
        mentioned = true;
        value = flag;
      }
    }
    const on = mentioned ? value : installedIds.includes(id);
    if (on) enabledId = id;
  }
  return enabledId ? { enabled: true, id: enabledId } : { enabled: false };
}

function enabledMap(settings: unknown): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const enabled = (settings as { enabledPlugins?: unknown }).enabledPlugins;
  if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) return undefined;
  return enabled as Record<string, unknown>;
}

export function loadInstalledOkedRecords(env: NodeJS.ProcessEnv = process.env): OkedInstallRecord[] {
  const records: OkedInstallRecord[] = [];
  for (const dir of claudePluginsDirs(env)) {
    const file = join(dir, "installed_plugins.json");
    if (!existsSync(file)) continue;
    records.push(...installedOkedRecords(readJson(file)));
  }
  return records;
}

function settingsLayers(cwd: string): unknown[] {
  return [
    readJson(claudeUserSettingsPath()),
    readJson(join(cwd, ".claude", "settings.json")),
    readJson(join(cwd, ".claude", "settings.local.json")),
  ];
}

/** True when an OKed Claude Code plugin should be loaded for this project. */
export function okedPluginIsEnabled(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const records = loadInstalledOkedRecords(env);
  return resolveOkedPluginEnabled(
    records.map((record) => record.id),
    settingsLayers(cwd),
  ).enabled;
}

/** True when an installed copy contains the bundled hook file. */
export function okedPluginBundleOnDisk(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadInstalledOkedRecords(env).some((record) => record.installPath && bundleExistsAt(record.installPath));
}

export function bundleExistsAt(installPath: string): boolean {
  if (installPath.endsWith("oked-hook.mjs")) return existsSync(installPath);
  return existsSync(join(installPath, OKED_PLUGIN_HOOK_FILE));
}

/**
 * The `oked init` settings hook returns allow, without calling OKed, when the
 * plugin is enabled and its hook file is on disk. The plugin hook then gates.
 * If the file is missing, this returns false and the settings hook still gates.
 */
export function settingsHookYieldsToPlugin(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return okedPluginIsEnabled(cwd, env) && okedPluginBundleOnDisk(env);
}

/**
 * The plugin hook returns allow, without calling OKed, when an `oked-hook`
 * command will also run for this tool and the settings hook is not yielding.
 * The two hooks never both yield, and they never both call OKed.
 */
export function pluginHookYieldsToSettingsHook(
  toolName: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (settingsHookYieldsToPlugin(cwd, env)) return false;
  return listClaudeOkedCommands(cwd).some(
    (command) => matcherCoversTool(command.matcher, toolName) && commandIsResolvable(command.command, env.PATH ?? ""),
  );
}
