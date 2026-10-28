import assert from "node:assert";
import { classify } from "@oked/sdk";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";
import { HOOK_COMMAND } from "../dist/install.js";
import { mapCursorTool } from "../dist/map.js";

let passed = 0;

function tier(name, input) {
  const mapped = mapCursorTool(name, input);
  return { mapped, tier: classify(mapped.toolName, mapped.toolInput) };
}

{
  assert.equal(tier("Shell", { command: "ls" }).tier, "safe");
  assert.equal(tier("Shell", { command: "rm -rf /var/data" }).tier, "high_stakes");
  assert.equal(tier("Shell", { command: "vercel --prod" }).tier, "high_stakes");
  assert.equal(tier("Read", { path: "README.md" }).tier, "safe");
  assert.equal(tier("Grep", { pattern: "x" }).tier, "safe");
  passed++;
}

{
  const project = tier("Write", { path: "src/app.ts", contents: "hi" });
  assert.equal(project.mapped.toolName, "Write");
  assert.equal(project.mapped.toolInput.file_path, "src/app.ts");
  assert.equal(project.tier, "warning");
  assert.equal(tier("Write", { path: "/etc/hosts", contents: "x" }).tier, "review");
  assert.equal(tier("StrReplace", { path: "src/app.ts" }).tier, "warning");
  passed++;
}

{
  assert.equal(tier("Delete", { path: "/tmp/scratch.txt" }).tier, "warning");
  assert.equal(tier("Delete", { path: "src/app.ts" }).tier, "high_stakes");
  assert.equal(tier("Delete", {}).tier, "review");
  passed++;
}

{
  assert.equal(tier("MCP:list_files", {}).tier, "safe");
  assert.equal(tier("MCP:github:create_issue", { title: "x" }).mapped.toolName, "mcp__github__create_issue");
  assert.equal(tier("MCP:github:create_issue", { title: "x" }).tier, "review");
  assert.equal(tier("MCP:github:delete_repo", {}).tier, "high_stakes");
  assert.equal(tier("Task", { prompt: "look" }).tier, "safe");
  assert.equal(tier("CustomTool", { value: 1 }).tier, "review");
  passed++;
}

{
  assert.equal(HOOK_TIMEOUT_SECONDS, 690);
  assert.equal(HOOK_COMMAND, "oked-cursor-hook");
  passed++;
}

console.log(`ok - @oked/cursor map: ${passed}/5 passed`);
