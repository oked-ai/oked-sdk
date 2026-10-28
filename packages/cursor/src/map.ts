import { asToolInput, mapFileDelete, stringField, withNormalizedFields } from "@oked/hook-core";

export interface MappedCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** `MCP:server:tool` becomes `mcp__server__tool`. A bare `MCP:tool` uses server `mcp`. */
export function toMcpToolName(name: string): string {
  if (name.startsWith("mcp__")) return name;
  const rest = name.replace(/^(?:MCP|mcp):/, "");
  const parts = rest.split(":").filter(Boolean);
  if (parts.length >= 2) return `mcp__${parts[0]}__${parts.slice(1).join("__")}`;
  return `mcp__mcp__${parts[0] || "tool"}`;
}

/**
 * Map a Cursor preToolUse call onto a name and input `classify()` understands.
 * Unknown tools stay unknown, which the classifier sends to approval.
 */
export function mapCursorTool(toolName: string, rawInput: unknown): MappedCall {
  const input = withNormalizedFields(asToolInput(rawInput));
  if (toolName === "Shell" || toolName === "shell" || toolName === "Bash") {
    return { toolName: "Bash", toolInput: input };
  }
  if (toolName === "Delete" || toolName === "delete_file") {
    return mapFileDelete(input);
  }
  if (toolName === "Task" || toolName === "Subagent") {
    return { toolName: "Agent", toolInput: input };
  }
  if (toolName === "EditNotebook") {
    return { toolName: "NotebookEdit", toolInput: input };
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "StrReplace") {
    return { toolName: toolName === "StrReplace" ? "Edit" : toolName, toolInput: input };
  }
  if (/^(?:MCP|mcp):/.test(toolName) || toolName.startsWith("mcp__")) {
    return { toolName: toMcpToolName(toolName), toolInput: input };
  }
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "WebSearch" || toolName === "WebFetch") {
    return { toolName, toolInput: input };
  }
  const server = stringField(input, ["server", "serverName", "mcp_server"]);
  const tool = stringField(input, ["tool", "name"]);
  if ((toolName === "MCP" || toolName === "mcp") && server && tool) {
    return { toolName: `mcp__${server}__${tool}`, toolInput: input };
  }
  return { toolName, toolInput: input };
}
