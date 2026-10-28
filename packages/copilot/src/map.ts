import { asToolInput, mapPatch, stringField, withNormalizedFields } from "@oked/hook-core";

const RENAME: Record<string, string> = {
  bash: "Bash",
  powershell: "Bash",
  view: "Read",
  create: "Write",
  edit: "Edit",
  str_replace_editor: "Edit",
  grep: "Grep",
  rg: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  ask_user: "AskUserQuestion",
  update_todo: "TodoWrite",
  task: "Agent",
  Task: "Agent",
};

export interface MappedCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Copilot MCP names are not listed in the hooks reference. `mcp__server__tool`
 * and `MCP:server:tool` map straight across. A single `mcp_` prefix keeps the
 * rest as the tool name, so `mcp_list_files` is a read and an unrecognized
 * name still requires approval.
 */
export function toMcpToolName(name: string): string {
  if (name.startsWith("mcp__")) return name;
  if (/^(?:MCP|mcp):/.test(name)) {
    const parts = name.replace(/^(?:MCP|mcp):/, "").split(":").filter(Boolean);
    if (parts.length >= 2) return `mcp__${parts[0]}__${parts.slice(1).join("__")}`;
    return `mcp__mcp__${parts[0] || "tool"}`;
  }
  if (name.startsWith("mcp_")) return `mcp__mcp__${name.slice(4)}`;
  return name;
}

/**
 * Map a Copilot preToolUse call onto a name and input `classify()` understands.
 * Runtime names (`bash`, `create`) and Claude names from a PascalCase payload
 * (`Bash`, `Write`) both work. Unknown tools stay unknown and require approval.
 */
export function mapCopilotTool(toolName: string, rawInput: unknown): MappedCall {
  const input = withNormalizedFields(asToolInput(rawInput));
  if (toolName === "apply_patch" || toolName === "ApplyPatch") {
    const patch = stringField(input, ["command", "patch", "input"]) ?? "";
    return mapPatch(patch);
  }
  const renamed = RENAME[toolName];
  if (renamed === "Bash" || toolName === "Bash" || toolName === "Shell") {
    return { toolName: "Bash", toolInput: input };
  }
  if (renamed === "Write" || renamed === "Edit" || toolName === "Write" || toolName === "Edit") {
    return { toolName: renamed === "Write" || renamed === "Edit" ? renamed : toolName, toolInput: input };
  }
  if (renamed) return { toolName: renamed, toolInput: input };
  if (/^(?:MCP|mcp):/.test(toolName) || toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
    return { toolName: toMcpToolName(toolName), toolInput: input };
  }
  const server = stringField(input, ["server", "serverName", "mcp_server"]);
  const tool = stringField(input, ["tool", "name"]);
  if ((toolName === "mcp" || toolName === "MCP") && server && tool) {
    return { toolName: `mcp__${server}__${tool}`, toolInput: input };
  }
  return { toolName, toolInput: input };
}
