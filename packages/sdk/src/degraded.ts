import type { RiskTier } from "./types.js";

/** Severity ordering for risk tiers. Higher = more dangerous. */
export const TIER_ORDER: Record<RiskTier, number> = {
  safe: 0,
  warning: 1,
  review: 2,
  high_stakes: 3,
};

/**
 * Decide what to do with a sensitive action when the OKed backend is
 * unreachable (NOT when the user explicitly denied — that is always honored,
 * and NOT for auth errors — those always deny).
 *
 *   strictFailClosed === true  -> "deny"  (original fail-safe: deny everything)
 *   otherwise                  -> "deny"  iff tier is high_stakes,
 *                                 "allow" for every lower tier.
 *
 * Rationale: a single backend outage should not mass-abort every user's
 * agent, but an irreversible action (rm -rf, payments, drops, force-push)
 * must never slip through unsupervised because of a network blip.
 */
export function degradedDecision(
  tier: RiskTier,
  opts: { strictFailClosed?: boolean },
): "allow" | "deny" {
  if (opts.strictFailClosed) return "deny";
  return tier === "high_stakes" ? "deny" : "allow";
}
