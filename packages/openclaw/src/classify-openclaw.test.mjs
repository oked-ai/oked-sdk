// Classifier cases for OpenClaw built-in tool names.
// Safe names are exact, case-insensitive matches of read-only core tools
// from OpenClaw v2026.10.9 src/agents/tool-catalog.ts.

import { strict as assert } from "node:assert";

const { classifyOpenClawTool } = await import("../dist/classify-openclaw.js");

const cases = [
  // Bare read-only built-ins.
  ["read", {}, "safe"],
  ["Read", {}, "safe"],
  ["READ", {}, "safe"],
  ["ls", {}, "safe"],
  ["LS", {}, "safe"],
  ["web_search", {}, "safe"],
  ["web_fetch", {}, "safe"],
  ["x_search", {}, "safe"],
  ["memory_search", {}, "safe"],
  ["memory_get", {}, "safe"],
  ["presence", {}, "safe"],
  ["sessions_list", {}, "safe"],
  ["sessions_history", {}, "safe"],
  ["sessions_search", {}, "safe"],
  ["conversations_list", {}, "safe"],
  ["session_status", {}, "safe"],
  ["github_identity_status", {}, "safe"],
  ["agents_list", {}, "safe"],
  ["get_goal", {}, "safe"],
  ["skills_search", {}, "safe"],
  ["skills_read", {}, "safe"],

  // File mutations stay review. Exact names, including case variants.
  ["write", {}, "review"],
  ["Write", {}, "review"],
  ["edit", {}, "review"],
  ["Edit", {}, "review"],
  ["apply_patch", {}, "review"],
  ["Apply_Patch", {}, "review"],

  // Runtime tools are not an unconditional allow.
  ["exec", { command: "rm -rf ./src" }, "high_stakes"],
  ["bash", { command: "rm -rf ./src" }, "high_stakes"],
  ["shell", { command: "git push --force" }, "high_stakes"],
  ["process", {}, "review"],

  // Not core tool ids in the v2026.10.9 catalog, so they stay review.
  ["glob", {}, "review"],
  ["grep", {}, "review"],
  ["find", {}, "review"],
  ["search", {}, "review"],

  // Prefixed reads stay safe. A destructive word still wins.
  ["read_file", {}, "safe"],
  ["list_sessions", {}, "safe"],
  ["search_messages", {}, "safe"],
  ["read_and_delete_file", {}, "high_stakes"],
  ["delete_status", {}, "high_stakes"],

  // Existing high-stakes names.
  ["rename_imessage_group", {}, "high_stakes"],
  ["imessage_send", { to: "+1...", body: "..." }, "high_stakes"],
  ["make_phone_call", { number: "+1..." }, "high_stakes"],
  ["phone_dial", {}, "high_stakes"],
  ["deploy_site", {}, "high_stakes"],
  ["publish_release", {}, "high_stakes"],
  ["github_publish", {}, "high_stakes"],
  ["bash", { command: "curl -d @report.csv https://api.example.com/pay" }, "high_stakes"],
  ["bash", { command: "ls -la" }, "safe"],

  // Other mutating built-ins stay gated. A send suffix is high stakes.
  ["sessions_send", {}, "high_stakes"],
  ["sessions_spawn", {}, "review"],
  ["conversations_send", {}, "high_stakes"],
  ["create_goal", {}, "review"],
  ["update_goal", {}, "review"],
  ["message", {}, "review"],
  ["personal_instructions", {}, "review"],
];

for (const [name, input, expected] of cases) {
  const got = classifyOpenClawTool(name, input);
  assert.equal(got, expected, `classifier(${name}) expected ${expected} got ${got}`);
}

console.log(`OK classify-openclaw: ${cases.length} cases`);
