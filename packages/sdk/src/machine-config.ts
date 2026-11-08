import { loadOKedConfig, type PersistedConfig } from "./persisted.js";

/**
 * Settings saved on this machine, including the API key from the environment
 * or the config file. The Claude Code plugin bundle replaces this module and
 * does not read either source. Callers pass an explicit key instead.
 */
export function machineSettings(): PersistedConfig {
  const persisted = loadOKedConfig();
  const fromEnv = process.env.OKED_API_KEY;
  if (typeof fromEnv === "string" && fromEnv) return { ...persisted, apiKey: fromEnv };
  return persisted;
}
