import assert from "node:assert";
import { classify } from "@oked/sdk";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";
import { HOOK_COMMAND } from "../dist/install.js";
import { mapCopilotTool } from "../dist/map.js";

let passed = 0;

function tier(name, input) {
  const mapped = mapCopilotTool(name, input);
  return { mapped, tier: classify(mapped.toolName, mapped.toolInput) };
}

{
  assert.equal(tier("bash", { command: "ls" }).tier, "safe");
  assert.equal(tier("powershell", { command: "git status" }).tier, "safe");
  assert.equal(tier("Bash", { command: "rm -rf /var/data" }).tier, "high_stakes");
  assert.equal(tier("bash", { command: "vercel --prod" }).tier, "high_stakes");
  assert.equal(tier("view", { path: "README.md" }).tier, "safe");
  assert.equal(tier("grep", { pattern: "x" }).tier, "safe");
  assert.equal(tier("web_search", { query: "oked" }).tier, "safe");
  assert.equal(tier("web_fetch", { url: "https://example.com" }).tier, "warning");
  assert.equal(tier("ask_user", { question: "ok?" }).tier, "safe");
  assert.equal(tier("task", { prompt: "look" }).tier, "safe");
  passed++;
}

{
  const created = tier("create", { path: "src/app.ts", contents: "hi" });
  assert.equal(created.mapped.toolName, "Write");
  assert.equal(created.mapped.toolInput.file_path, "src/app.ts");
  assert.equal(created.tier, "warning");
  assert.equal(tier("edit", { path: "/etc/hosts", new_string: "x" }).tier, "review");
  const patch = tier("apply_patch", { command: "*** Delete File: src/app.ts\n" });
  assert.equal(patch.tier, "high_stakes");
  passed++;
}

{
  assert.equal(tier("mcp__github__list_issues", {}).tier, "safe");
  assert.equal(tier("mcp_list_files", {}).tier, "safe");
  assert.equal(tier("MCP:github:create_issue", { title: "x" }).tier, "review");
  assert.equal(tier("mcp__github__delete_repo", {}).tier, "high_stakes");
  assert.equal(tier("mystery_tool", { value: 1 }).tier, "review");
  passed++;
}

{
  assert.equal(HOOK_TIMEOUT_SECONDS, 690);
  assert.equal(HOOK_COMMAND, "oked-copilot-hook");
  passed++;
}

console.log(`ok - @oked/copilot map: ${passed}/4 passed`);
