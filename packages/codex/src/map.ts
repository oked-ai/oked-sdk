import { asToolInput, mapPatch, stringField, withNormalizedFields } from "@oked/hook-core";

const SHELL_NAMES = new Set([
  "bash",
  "shell",
  "exec",
  "exec_command",
  "shell_command",
  "local_shell",
  "container.exec",
]);

export interface MappedCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** `MCP:server:tool` or `mcp:server:tool` becomes `mcp__server__tool`. */
export function toMcpToolName(name: string): string {
  if (name.startsWith("mcp__")) return name;
  const rest = name.replace(/^(?:MCP|mcp):/, "");
  const parts = rest.split(":").filter(Boolean);
  if (parts.length >= 2) return `mcp__${parts[0]}__${parts.slice(1).join("__")}`;
  return `mcp__mcp__${parts[0] || "tool"}`;
}

/**
 * Map a Codex PreToolUse call onto a name and input `classify()` understands.
 * Unknown tools are left unknown, which the classifier sends to approval.
 */
export function mapCodexTool(toolName: string, rawInput: unknown): MappedCall {
  const input = withNormalizedFields(asToolInput(rawInput));
  if (toolName === "apply_patch" || toolName === "ApplyPatch") {
    const patch =
      stringField(input, ["command", "patch", "input"]) ??
      (typeof rawInput === "string" ? rawInput : "");
    return mapPatch(patch);
  }
  if (toolName === "spawn_agent" || toolName === "Agent") {
    return { toolName: "Agent", toolInput: input };
  }
  if (toolName === "Bash" || SHELL_NAMES.has(toolName)) {
    return { toolName: "Bash", toolInput: input };
  }
  if (toolName.startsWith("mcp__") || /^(?:MCP|mcp):/.test(toolName)) {
    return { toolName: toMcpToolName(toolName), toolInput: input };
  }
  return { toolName, toolInput: input };
}
