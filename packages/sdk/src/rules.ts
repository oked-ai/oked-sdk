/**
 * User-defined classification rules. Pure evaluation — no I/O.
 *
 * Rules are an ordered list per user; the SDK evaluates top-to-bottom and
 * stops at the first match. This matches Gmail's "filter messages like
 * this" model: the order IS the policy. No baked-in "most restrictive
 * wins" — if the user wants deny to beat approve, they put deny first.
 *
 * Matchers reference the fields produced by `describeFields()` (Title,
 * Target, Body, Kind), plus `cwd` from the hook input. This keeps the
 * matcher vocabulary aligned with what the user sees in the approval
 * card; they don't need to know that bash uses `command` while Write
 * uses `file_path`.
 *
 * This module is intentionally I/O-free. Fetching/caching rules from the
 * backend lives in `OKedClient`; wiring `applyRules()` into the hook
 * lives in `@oked/claude-code`. Keeping evaluation pure makes the unit
 * tests trivial and the hot path deterministic.
 */

import type { RiskTier } from "./types.js";

/**
 * Operator + value for a single matched field. `is_empty` is the only
 * op that doesn't take a value (it matches when the field is missing or
 * the empty string).
 */
export type FieldOp =
  | { op: "equals"; value: string }
  | { op: "contains"; value: string }
  | { op: "starts_with"; value: string }
  | { op: "matches"; value: string } // regex source
  | { op: "is_empty" };

/**
 * Match clause. All present field-ops must pass (AND). Absent fields
 * are ignored — a rule with only `{ kind: { op: "equals", value: "X" } }`
 * matches any action whose Kind is X, regardless of Title/Target/etc.
 */
export interface RuleMatch {
  kind?: FieldOp;
  title?: FieldOp;
  target?: FieldOp;
  body?: FieldOp;
  cwd?: FieldOp;
}

/**
 * Action the rule takes when its match clause is satisfied.
 *
 * - `auto_approve` / `auto_deny`: skip the network round-trip entirely.
 *   The hook synthesizes the decision locally and logs `appliedRuleId`.
 * - `set_tier`: still go to the backend for human approval, but with the
 *   user-specified tier. Used both to escalate (e.g. production matches
 *   → high_stakes) and to reduce (e.g. trusted npm scripts → warning).
 */
export type RuleAction = "auto_approve" | "auto_deny" | "set_tier";

export interface Rule {
  id: string;
  match: RuleMatch;
  action: RuleAction;
  /** Required when `action === "set_tier"`; ignored otherwise. */
  tier?: RiskTier;
}

/**
 * Verdict from `applyRules()`. `outcome === "ask"` means proceed to the
 * normal backend approval flow (with `tier` possibly overridden by a
 * `set_tier` rule). `auto_approve` / `auto_deny` mean the hook can
 * decide locally without a network call.
 */
export interface RuleDecision {
  outcome: "ask" | "auto_approve" | "auto_deny";
  /** Final tier after any `set_tier` override. */
  tier: RiskTier;
  /** Set when a rule fired. */
  appliedRuleId?: string;
  /** Set when `set_tier` changed the tier from the classifier default. */
  tierOverriddenFrom?: RiskTier;
}

/** Internal: map rule-match field name → `describeFields` output key. */
const FIELD_KEY: Record<Exclude<keyof RuleMatch, "cwd">, string> = {
  kind: "Kind",
  title: "Title",
  target: "Target",
  body: "Body",
};

function evalFieldOp(op: FieldOp, value: string | undefined): boolean {
  switch (op.op) {
    case "is_empty":
      return !value;
    case "equals":
      return value === op.value;
    case "contains":
      return value !== undefined && value.includes(op.value);
    case "starts_with":
      return value !== undefined && value.startsWith(op.value);
    case "matches":
      if (value === undefined) return false;
      try {
        return new RegExp(op.value).test(value);
      } catch {
        // Invalid user-supplied regex never throws into the hot path —
        // it just fails to match. The dashboard validates regexes at
        // create time; this is a belt-and-braces defense.
        return false;
      }
  }
}

function ruleMatches(
  rule: Rule,
  fields: Record<string, string>,
  cwd: string,
): boolean {
  const m = rule.match;
  if (m.kind && !evalFieldOp(m.kind, fields[FIELD_KEY.kind])) return false;
  if (m.title && !evalFieldOp(m.title, fields[FIELD_KEY.title])) return false;
  if (m.target && !evalFieldOp(m.target, fields[FIELD_KEY.target])) return false;
  if (m.body && !evalFieldOp(m.body, fields[FIELD_KEY.body])) return false;
  if (m.cwd && !evalFieldOp(m.cwd, cwd)) return false;
  return true;
}

/**
 * Evaluate user rules against a classified action. Rules are assumed to
 * be sorted by user-defined position (top = highest priority). The first
 * rule whose match clause is satisfied produces the verdict; evaluation
 * stops there. If no rule matches, returns the classifier default with
 * `outcome: "ask"`.
 */
export function applyRules(
  classified: { tier: RiskTier; fields: Record<string, string> },
  rules: Rule[],
  ctx: { cwd: string },
): RuleDecision {
  for (const rule of rules) {
    if (!ruleMatches(rule, classified.fields, ctx.cwd)) continue;

    switch (rule.action) {
      case "auto_approve":
        return {
          outcome: "auto_approve",
          tier: classified.tier,
          appliedRuleId: rule.id,
        };
      case "auto_deny":
        return {
          outcome: "auto_deny",
          tier: classified.tier,
          appliedRuleId: rule.id,
        };
      case "set_tier": {
        // A set_tier rule with no `tier` is malformed; ignore it and
        // keep evaluating. The dashboard prevents creating such rules;
        // this guards against bad backend payloads.
        if (!rule.tier) continue;
        return {
          outcome: "ask",
          tier: rule.tier,
          appliedRuleId: rule.id,
          tierOverriddenFrom:
            rule.tier !== classified.tier ? classified.tier : undefined,
        };
      }
    }
  }

  return { outcome: "ask", tier: classified.tier };
}
