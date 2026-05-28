import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRules, type Rule } from "../src/rules.js";

const ctx = { cwd: "/home/u/proj" };

const sshFields = {
  Title: "SSH to user@staging-1.example.com",
  Target: "user@staging-1.example.com",
  Kind: "ssh_remote",
};

const npmFields = {
  Title: "Run command",
  Body: "npm run test",
  Kind: "npm_run",
};

const rmFields = {
  Title: "Delete file recursively",
  Target: "/var/log/",
  Kind: "file_delete",
};

describe("applyRules — empty / no-match", () => {
  it("empty rules → ask with classifier default tier", () => {
    const d = applyRules(
      { tier: "review", fields: sshFields },
      [],
      ctx,
    );
    assert.equal(d.outcome, "ask");
    assert.equal(d.tier, "review");
    assert.equal(d.appliedRuleId, undefined);
    assert.equal(d.tierOverriddenFrom, undefined);
  });

  it("rules that don't match → ask with default", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { kind: { op: "equals", value: "file_delete" } },
        action: "auto_approve",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
    assert.equal(d.tier, "high_stakes");
  });
});

describe("applyRules — basic actions", () => {
  it("auto_approve matching by kind", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { kind: { op: "equals", value: "ssh_remote" } },
        action: "auto_approve",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_approve");
    assert.equal(d.appliedRuleId, "r1");
    // tier is preserved (informational) even when auto-approved
    assert.equal(d.tier, "high_stakes");
  });

  it("auto_deny matching by Target contains", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { target: { op: "contains", value: "production" } },
        action: "auto_deny",
      },
    ];
    const prodFields = { ...sshFields, Target: "user@production-db.aws.com" };
    const d = applyRules(
      { tier: "high_stakes", fields: prodFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_deny");
    assert.equal(d.appliedRuleId, "r1");
  });
});

describe("applyRules — set_tier", () => {
  it("set_tier high_stakes escalates (review → high_stakes)", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { target: { op: "contains", value: "production" } },
        action: "set_tier",
        tier: "high_stakes",
      },
    ];
    const prodFields = { ...sshFields, Target: "user@production-db.aws.com" };
    const d = applyRules(
      { tier: "review", fields: prodFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
    assert.equal(d.tier, "high_stakes");
    assert.equal(d.tierOverriddenFrom, "review");
    assert.equal(d.appliedRuleId, "r1");
  });

  it("set_tier warning reduces (high_stakes → warning)", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { body: { op: "contains", value: "npm run test" } },
        action: "set_tier",
        tier: "warning",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: npmFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
    assert.equal(d.tier, "warning");
    assert.equal(d.tierOverriddenFrom, "high_stakes");
  });

  it("set_tier with same tier as default → no tierOverriddenFrom", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { kind: { op: "equals", value: "ssh_remote" } },
        action: "set_tier",
        tier: "review",
      },
    ];
    const d = applyRules(
      { tier: "review", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
    assert.equal(d.tier, "review");
    assert.equal(d.tierOverriddenFrom, undefined);
    assert.equal(d.appliedRuleId, "r1");
  });

  it("set_tier without tier → malformed, skipped, evaluation continues", () => {
    const rules: Rule[] = [
      {
        id: "bad",
        match: { kind: { op: "equals", value: "ssh_remote" } },
        action: "set_tier",
        // tier missing
      },
      {
        id: "ok",
        match: { kind: { op: "equals", value: "ssh_remote" } },
        action: "auto_approve",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_approve");
    assert.equal(d.appliedRuleId, "ok");
  });
});

describe("applyRules — ordering (first match wins)", () => {
  it("deny at top beats broad approve below", () => {
    const rules: Rule[] = [
      {
        id: "deny-prod",
        match: { target: { op: "contains", value: "production" } },
        action: "auto_deny",
      },
      {
        id: "approve-all-ssh",
        match: { kind: { op: "equals", value: "ssh_remote" } },
        action: "auto_approve",
      },
    ];
    const prodFields = { ...sshFields, Target: "user@production-db.aws.com" };
    const d = applyRules(
      { tier: "high_stakes", fields: prodFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_deny");
    assert.equal(d.appliedRuleId, "deny-prod");
  });

  it("broad approve at top beats narrow deny below (footgun case)", () => {
    // This is the case the dashboard UI must surface — putting a broad
    // approve rule above a narrower deny rule means the deny will never
    // fire. The pure function honors the user's stated order.
    const rules: Rule[] = [
      {
        id: "approve-all-ssh",
        match: { kind: { op: "equals", value: "ssh_remote" } },
        action: "auto_approve",
      },
      {
        id: "deny-prod",
        match: { target: { op: "contains", value: "production" } },
        action: "auto_deny",
      },
    ];
    const prodFields = { ...sshFields, Target: "user@production-db.aws.com" };
    const d = applyRules(
      { tier: "high_stakes", fields: prodFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_approve");
    assert.equal(d.appliedRuleId, "approve-all-ssh");
  });
});

describe("applyRules — AND semantics within a match clause", () => {
  it("all listed fields must match", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: {
          kind: { op: "equals", value: "ssh_remote" },
          target: { op: "contains", value: "staging" },
        },
        action: "auto_approve",
      },
    ];
    // kind matches, target doesn't → no match
    const d = applyRules(
      {
        tier: "high_stakes",
        fields: { ...sshFields, Target: "user@prod.example.com" },
      },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
  });

  it("all listed fields match → fires", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: {
          kind: { op: "equals", value: "ssh_remote" },
          target: { op: "contains", value: "staging" },
        },
        action: "auto_approve",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_approve");
  });
});

describe("applyRules — cwd scoping", () => {
  it("cwd match limits rule to a project prefix", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: {
          body: { op: "contains", value: "npm run test" },
          cwd: { op: "starts_with", value: "/home/u/proj" },
        },
        action: "auto_approve",
      },
    ];
    const inside = applyRules(
      { tier: "review", fields: npmFields },
      rules,
      { cwd: "/home/u/proj/sub" },
    );
    assert.equal(inside.outcome, "auto_approve");

    const outside = applyRules(
      { tier: "review", fields: npmFields },
      rules,
      { cwd: "/home/u/other" },
    );
    assert.equal(outside.outcome, "ask");
  });
});

describe("applyRules — operators", () => {
  it("starts_with on Title", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { title: { op: "starts_with", value: "Delete file" } },
        action: "auto_deny",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: rmFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_deny");
  });

  it("matches (regex) on Target", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { target: { op: "matches", value: "@staging-\\d+\\." } },
        action: "auto_approve",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_approve");
  });

  it("invalid regex doesn't throw; just fails to match", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { target: { op: "matches", value: "[unclosed" } },
        action: "auto_deny",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
  });

  it("is_empty matches when field is absent", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: {
          kind: { op: "equals", value: "npm_run" },
          target: { op: "is_empty" },
        },
        action: "auto_approve",
      },
    ];
    // npmFields has no Target
    const d = applyRules(
      { tier: "review", fields: npmFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "auto_approve");
  });

  it("is_empty does NOT match when field is present", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        match: { target: { op: "is_empty" } },
        action: "auto_approve",
      },
    ];
    const d = applyRules(
      { tier: "high_stakes", fields: sshFields },
      rules,
      ctx,
    );
    assert.equal(d.outcome, "ask");
  });
});
