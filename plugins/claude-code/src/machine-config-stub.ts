/** Plugin build: do not read an API key from the environment or from disk. */
export function machineSettings(): Record<string, never> {
  return {};
}
