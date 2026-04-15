#!/usr/bin/env node
/**
 * OKed — Claude Code PreToolUse Hook
 *
 * Only intercepts genuinely sensitive operations:
 * - Bash commands classified as high_stakes (rm -rf, git push --force, etc.)
 * - MCP tool calls (send_email, create_payment, delete_*, etc.)
 *
 * Everything else passes through without touching the backend.
 */

import { classify, OKedClient, describe as describeAction } from '@oked/sdk';

const oked = new OKedClient(); // reads OKED_API_KEY + OKED_BACKEND_URL from env

// Only these tiers go to OKed for approval
const NEEDS_APPROVAL = new Set(['high_stakes', 'warning']);

// Tools that never need approval (read-only, meta, internal)
const PASSTHROUGH_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'TodoRead', 'TodoWrite', 'TaskGet', 'TaskList',
  'ExitPlanMode', 'EnterPlanMode',
  'ToolSearch', 'Agent', 'Skill',
  'Write', 'Edit', 'NotebookEdit', // file edits — only Bash destructive ops need approval
]);

function allow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }));
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    allow('Could not parse hook input');
    return;
  }

  const { tool_name: toolName, tool_input: toolInput, session_id, cwd } = input;

  // Pass through all non-Bash and non-MCP tools
  if (PASSTHROUGH_TOOLS.has(toolName)) {
    allow('Passthrough tool');
    return;
  }

  const tier = classify(toolName, toolInput);

  if (!NEEDS_APPROVAL.has(tier)) {
    allow(`Tier: ${tier} — no approval needed`);
    return;
  }

  // This is a genuinely sensitive operation — send to OKed
  const description = describeAction(toolName, toolInput);
  const dashboardUrl = `${oked.backendUrl}/dashboard`;

  process.stderr.write(
    `\n╔══════════════════════════════════════════╗\n` +
    `║         OKed — Approval Required         ║\n` +
    `╠══════════════════════════════════════════╣\n` +
    `║  Tool : ${toolName.padEnd(34)} ║\n` +
    `║  Risk : ${tier.padEnd(34)} ║\n` +
    `╠══════════════════════════════════════════╣\n` +
    `║  → ${dashboardUrl.padEnd(38)} ║\n` +
    `╚══════════════════════════════════════════╝\n\n`
  );

  try {
    const result = await oked.approve({
      action: toolName,
      description,
      tier,
      tool_input: toolInput,
      session_id,
      cwd,
    });

    if (result.approved) {
      process.stderr.write(`[OKed] ✓ Approved — proceeding with ${toolName}\n\n`);
      allow('Approved by user via OKed dashboard');
    } else {
      process.stderr.write(`[OKed] ✗ ${result.decision} — blocking ${toolName}\n\n`);
      deny(`${result.decision} via OKed`);
    }
  } catch (err) {
    process.stderr.write(`[OKed] Error: ${err.message} — fail-safe deny\n\n`);
    deny(`OKed error: ${err.message}`);
  }
}

main().catch(err => {
  process.stderr.write(`[OKed] Unexpected error: ${err.message}\n`);
  deny(`Hook error: ${err.message}`);
});
