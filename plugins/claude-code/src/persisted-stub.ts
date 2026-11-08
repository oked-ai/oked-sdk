/** Plugin build: do not read or name the on-disk settings file. */
export function loadOKedConfig(): Record<string, never> {
  return {};
}

export const OKED_CONFIG_PATH = "";
