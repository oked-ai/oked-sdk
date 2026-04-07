import path from "path";
import type { RiskTier } from "./types.js";

const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "TodoRead",
  "TaskGet",
  "TaskList",
]);

const NORMAL_TOOLS = new Set<string>([]);
const HIGH_STAKES_TOOLS = new Set<string>([]);

const SAFE_COMMANDS = [
  /^ls\b/,
  /^pwd$/,
  /^echo\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^date$/,
  /^whoami$/,
  /^which\b/,
  /^type\b/,
  /^file\b/,
  /^stat\b/,
  /^du\b/,
  /^df\b/,
  /^uname\b/,
  /^env$/,
  /^printenv\b/,
  /^node\s+(-v|--version)/,
  /^npm\s+(list|ls|--version|-v|view|info|outdated|audit)\b/,
  /^npx\s+-v/,
  /^git\s+(status|log|diff|branch|remote|show|tag|stash list)\b/,
  /^docker\s+(ps|images|inspect|logs)\b/,
  /^docker\s+compose\s+(ps|logs)\b/,
  /^tree\b/,
  /^find\b/,
  /^grep\b/,
  /^rg\b/,
  /^fd\b/,
  /^jq\b/,
  /^curl\s+-s.*\|\s*(jq|python|node)/,
];

const HIGH_STAKES_COMMANDS = [
  /\brm\s+(-rf?|--recursive)\b/,
  /\brm\b.*\s+\//,
  /\bgit\s+push\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+restore\s+--staged\s+\./,
  /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune)\b/,
  /\bdocker\s+compose\s+down\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bkillall\b/,
  /\bchmod\s+777\b/,
  /\bcurl\s+.*-X\s*(DELETE|PUT|POST)\b/,
  /\bcurl\s+.*--request\s*(DELETE|PUT|POST)\b/,
  /\bwget\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bcurl\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bnpm\s+publish\b/,
  /\bnpm\s+unpublish\b/,
  /\bnpx\s+.*\s+deploy\b/,
];

function isInsideProject(filePath: string): boolean {
  if (!filePath) return false;
  try {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(process.cwd());
  } catch {
    return false;
  }
}

export function classify(toolName: string, toolInput: Record<string, unknown>): RiskTier {
  if (SAFE_TOOLS.has(toolName)) return "safe";
  if (HIGH_STAKES_TOOLS.has(toolName)) return "high_stakes";
  if (NORMAL_TOOLS.has(toolName)) return "normal";

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath = toolInput.file_path as string;
    return isInsideProject(filePath) ? "warning" : "normal";
  }

  if (toolName === "Agent") return "normal";

  if (toolName === "Bash") {
    return classifyBashCommand(toolInput.command as string);
  }

  if (toolName.startsWith("mcp__")) {
    return classifyMcpTool(toolName);
  }

  return "normal";
}

function classifyBashCommand(command: string): RiskTier {
  if (!command) return "safe";

  const trimmed = command.trim();

  if (/^sudo\s/.test(trimmed)) {
    const inner = trimmed.replace(/^sudo\s+/, "");
    for (const pattern of HIGH_STAKES_COMMANDS) {
      if (pattern.test(inner)) return "high_stakes";
    }
    return "normal";
  }

  for (const pattern of HIGH_STAKES_COMMANDS) {
    if (pattern.test(trimmed)) return "high_stakes";
  }

  for (const pattern of SAFE_COMMANDS) {
    if (pattern.test(trimmed)) return "safe";
  }

  return "normal";
}

function classifyMcpTool(toolName: string): RiskTier {
  const parts = toolName.split("__");
  const tool = parts[parts.length - 1] || "";

  if (tool.startsWith("list_") || tool.startsWith("get_") || tool.startsWith("search_")) {
    return "safe";
  }
  if (tool.startsWith("delete_") || tool.startsWith("drop_") || tool.startsWith("remove_")) {
    return "high_stakes";
  }
  if (tool.startsWith("send_") || tool.startsWith("create_") || tool.startsWith("update_")) {
    return "normal";
  }

  return "normal";
}
