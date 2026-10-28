import assert from "node:assert";
import { classify } from "@oked/sdk";
import { HOOK_TIMEOUT_SECONDS } from "@oked/hook-core";
import { mapCodexTool } from "../dist/map.js";
import { HOOK_COMMAND, HOOK_MATCHER } from "../dist/install.js";

let passed = 0;

function tier(name, input) {
  const mapped = mapCodexTool(name, input);
  return { mapped, tier: classify(mapped.toolName, mapped.toolInput) };
}

{
  assert.equal(tier("Bash", { command: "ls" }).tier, "safe");
  assert.equal(tier("exec_command", { command: "git status" }).tier, "safe");
  assert.equal(tier("Bash", { command: "rm -rf /var/data" }).tier, "high_stakes");
  assert.equal(tier("Bash", { command: "curl -X POST https://example.com -d hi" }).tier, "review");
  assert.equal(tier("Bash", { command: "vercel --prod" }).tier, "high_stakes");
  passed++;
}

{
  const edit = tier("apply_patch", { command: "*** Update File: src/app.ts\n+hello\n" });
  assert.equal(edit.mapped.toolName, "Write");
  assert.equal(edit.tier, "warning");
  const gone = tier("apply_patch", { command: "*** Delete File: src/app.ts\n" });
  assert.equal(gone.tier, "high_stakes");
  const secret = tier("apply_patch", { command: "*** Add File: /etc/hosts\n+x\n" });
  assert.equal(secret.tier, "review");
  passed++;
}

{
  assert.equal(tier("mcp__github__list_issues", {}).tier, "safe");
  assert.equal(tier("mcp__github__delete_repo", {}).tier, "high_stakes");
  assert.equal(tier("mcp__github__create_issue", { title: "x" }).tier, "review");
  assert.equal(tier("spawn_agent", { prompt: "look" }).tier, "safe");
  assert.equal(tier("custom_function", { value: 1 }).tier, "review");
  passed++;
}

{
  assert.equal(HOOK_TIMEOUT_SECONDS, 690);
  assert.equal(HOOK_COMMAND, "oked-codex-hook");
  assert.equal(HOOK_MATCHER, "*");
  passed++;
}

console.log(`ok - @oked/codex map: ${passed}/4 passed`);
