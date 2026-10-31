/** `enforce` pauses a risky action. `watch` lets it run and records that it would have paused. */
export type OkedMode = "watch" | "enforce";

export function parseOkedMode(value: unknown): OkedMode | undefined {
  return value === "watch" || value === "enforce" ? value : undefined;
}
