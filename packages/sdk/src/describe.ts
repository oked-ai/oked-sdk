export function describe(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return describeBash(toolInput.command as string);
    case "Write":
      return describeWrite(toolInput);
    case "Edit":
      return describeEdit(toolInput);
    case "NotebookEdit": {
      const filePath = toolInput.file_path as string;
      return `Edit notebook: ${filePath ? shortenPath(filePath) : "file"}`;
    }
    case "Agent":
      return describeAgent(toolInput);
    default:
      if (toolName.startsWith("mcp__")) {
        return describeMcp(toolName, toolInput);
      }
      const readable = toolName.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
      return `${readable}${Object.keys(toolInput).length ? `: ${summarizeArgs(toolInput)}` : ""}`;
  }
}

function describeBash(command: string): string {
  if (!command) return "Run empty command";

  const cmd = command.trim();

  if (/docker\s+compose\s+down/.test(cmd)) return "Stop and remove Docker containers";
  if (/docker\s+compose\s+up/.test(cmd)) return "Start Docker containers";
  if (/docker\s+system\s+prune/.test(cmd)) return "Remove all stopped containers, unused images, and networks";

  if (/docker\s+rmi\b/.test(cmd)) {
    const name = cmd.match(/docker\s+rmi\s+(\S+)/)?.[1];
    return `Remove Docker image${name ? `: ${name}` : ""}`;
  }
  if (/docker\s+rm\b/.test(cmd)) {
    const name = cmd.match(/docker\s+rm\s+(\S+)/)?.[1];
    return `Remove Docker container${name ? `: ${name}` : ""}`;
  }

  if (/\brm\s+(-rf?|--recursive)\b/.test(cmd)) {
    const target = cmd.replace(/^.*rm\s+(-rf?|--recursive)\s+/, "").trim();
    return `Delete ${target || "files"} and all contents`;
  }
  if (/\brm\b/.test(cmd)) {
    const target = cmd.replace(/^.*rm\s+/, "").trim();
    return `Delete ${target || "files"}`;
  }

  if (/git\s+push\s+--force/.test(cmd) || /git\s+push\s+-f\b/.test(cmd)) {
    const match = cmd.match(/git\s+push\s+(?:--force|-f)\s+\w+\s+(\S+)/);
    return `Force push to ${match?.[1] || "remote"} branch`;
  }
  if (/git\s+push/.test(cmd)) {
    const match = cmd.match(/git\s+push\s+\w+\s+(\S+)/);
    return `Push ${match?.[1] || "current branch"} to remote`;
  }

  if (/git\s+reset\s+--hard/.test(cmd)) return "Hard reset — discard all local changes";
  if (/git\s+clean\s+-f/.test(cmd)) return "Remove all untracked files from working directory";
  if (/git\s+checkout\s+--\s+\./.test(cmd)) return "Discard all unstaged changes in working directory";
  if (/git\s+restore\s+--staged\s+\./.test(cmd)) return "Unstage all staged changes";

  if (/git\s+commit/.test(cmd)) {
    const match = cmd.match(/-m\s+["']([^"']+)["']/);
    return match ? `Git commit: "${match[1]}"` : "Git commit";
  }

  if (/curl\s+.*-X\s*(DELETE|POST|PUT)/i.test(cmd)) {
    const method = cmd.match(/-X\s*(DELETE|POST|PUT)/i)?.[1] || "request";
    const url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0] || "URL";
    return `${method} request to ${extractHost(url)}`;
  }

  if (/npm\s+run\s+(\S+)/.test(cmd)) {
    const script = cmd.match(/npm\s+run\s+(\S+)/)?.[1];
    return `Run npm script: ${script}`;
  }
  if (/npm\s+install/.test(cmd)) return "Install npm dependencies";
  if (/npm\s+test/.test(cmd)) return "Run tests";
  if (/npm\s+publish/.test(cmd)) return "Publish package to npm";
  if (/npm\s+unpublish/.test(cmd)) return "Unpublish package from npm registry";
  if (/npx\s+.*\s+deploy\b/.test(cmd)) {
    return `Deploy via npx: ${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}`;
  }

  if (/CREATE\s+TABLE/i.test(cmd)) {
    const match = cmd.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\S+)/i);
    return `Create DB table${match?.[1] ? ` '${match[1]}'` : ""}`;
  }
  if (/DROP\s+TABLE/i.test(cmd)) {
    const match = cmd.match(/DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(\S+)/i);
    return `Drop DB table${match?.[1] ? ` '${match[1]}'` : ""}`;
  }
  if (/DROP\s+DATABASE/i.test(cmd)) {
    const match = cmd.match(/DROP\s+DATABASE\s+(\S+)/i);
    return `Drop database '${match?.[1]}'`;
  }
  if (/DELETE\s+FROM/i.test(cmd)) {
    const match = cmd.match(/DELETE\s+FROM\s+(\S+)/i);
    return `Delete records from '${match?.[1]}'`;
  }
  if (/TRUNCATE\b/i.test(cmd)) {
    const match = cmd.match(/TRUNCATE\s+(?:TABLE\s+)?(\S+)/i);
    return `Delete all rows from '${match?.[1] ?? "table"}'`;
  }

  if (/\bkill\b/.test(cmd)) return `Kill process: ${cmd}`;
  if (/\bsudo\b/.test(cmd)) return `Run as root: ${cmd.replace(/sudo\s+/, "")}`;
  if (/\bchmod\s+777\b/.test(cmd)) {
    const target = cmd.match(/chmod\s+777\s+(\S+)/)?.[1];
    return `Make ${target ?? "file"} world-writable (chmod 777)`;
  }
  if (/\bwget\b.*\|\s*(bash|sh|zsh)\b/.test(cmd)) {
    const url = cmd.match(/https?:\/\/[^\s|'"]+/)?.[0];
    return `Download and execute script${url ? ` from ${extractHost(url)}` : ""}`;
  }
  if (/\bcurl\b.*\|\s*(bash|sh|zsh)\b/.test(cmd)) {
    const url = cmd.match(/https?:\/\/[^\s|'"]+/)?.[0];
    return `Download and execute script${url ? ` from ${extractHost(url)}` : ""}`;
  }

  if (/^(ls|pwd|echo|cat|head|tail|date|whoami|which|tree|find|grep|wc)\b/.test(cmd)) {
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }

  return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
}

function describeWrite(input: Record<string, unknown>): string {
  const filePath = input.file_path as string;
  if (!filePath) return "Create file";
  const shortPath = shortenPath(filePath);

  if (/\.(env|pem|key|secret|token)/.test(filePath)) {
    return `Create sensitive file: ${shortPath}`;
  }

  return `Create file: ${shortPath}`;
}

function describeEdit(input: Record<string, unknown>): string {
  const filePath = input.file_path as string;
  if (!filePath) return "Edit file";
  return `Edit ${shortenPath(filePath)}`;
}

function describeAgent(input: Record<string, unknown>): string {
  const prompt = input.prompt as string;
  if (!prompt) return "Launch sub-agent";
  const short = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
  return `Launch sub-agent: ${short}`;
}

function formatMoney(amount: unknown, currency: unknown): string {
  const num = typeof amount === "number" ? amount : parseFloat(String(amount));
  if (isNaN(num)) return String(amount);
  const cur = String(currency || "").toLowerCase();
  const symbols: Record<string, string> = { usd: "$", eur: "€", gbp: "£", jpy: "¥", cad: "CA$", aud: "A$" };
  const symbol = symbols[cur] || (cur ? `${cur.toUpperCase()} ` : "");
  const wholeCurrencies = ["jpy", "krw", "vnd", "clp"];
  const isWhole = wholeCurrencies.includes(cur);
  const value = isWhole ? num : num / 100;
  return `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function describeMcp(toolName: string, input: Record<string, unknown>): string {
  const parts = toolName.split("__");
  const server = parts[1] || "unknown";
  const tool = parts[2] || "unknown";

  if (tool === "send_email") return `Send email to ${input.to || "recipient"} via ${server}`;
  if (tool === "send_message") {
    const to = (input.to ?? input.chat_id ?? input.channel ?? input.recipient ?? "recipient") as string;
    const text = (input.text ?? input.message ?? "") as string;
    const preview = text.length > 40 ? `${text.slice(0, 37)}...` : text;
    return `Send ${server} message to ${to}${preview ? `: "${preview}"` : ""}`;
  }
  if (tool === "query_database") {
    return `Run SQL query: ${(input.query as string)?.slice(0, 60) || "..."}`;
  }
  if (tool === "create_table") {
    const name = (input.name ?? input.table ?? input.table_name ?? null) as string | null;
    const preview = name ? ` "${name}"` : "";
    return `Create DB table${preview} via ${server}`;
  }
  if (tool === "drop_table") {
    const name = (input.name ?? input.table ?? input.table_name ?? null) as string | null;
    return `Drop DB table${name ? ` '${name}'` : ""} via ${server}`;
  }
  if (tool.startsWith("delete_")) return `Delete ${tool.replace("delete_", "")} via ${server}`;
  if (tool === "create_payment" || tool === "charge_card" || tool.includes("payment") || tool.includes("charge")) {
    const amount = formatMoney(input.amount, input.currency);
    if (tool === "charge_card") {
      const card = (input.card as string) || "";
      const last4 = input.last4 ?? input.last_four ?? (card.length >= 4 ? card.slice(-4) : null);
      return last4 ? `Charge ${amount} to card ending ${last4} via ${server}` : `Charge ${amount} via ${server}`;
    }
    return `Create ${amount} payment via ${server}`;
  }
  if (tool === "submit_form") {
    const url = (input.url as string) || "";
    const host = url ? (() => { try { return new URL(url).hostname; } catch { return url.slice(0, 40); } })() : null;
    return `Submit form${host ? ` at ${host}` : ""} via ${server}`;
  }
  if (tool === "fill" || tool === "type") {
    const selector = (input.selector as string) || (input.locator as string) || "field";
    const value = (input.value as string) || "";
    const preview = value.length > 30 ? `${value.slice(0, 27)}...` : value;
    return `Fill ${selector} with "${preview}" via ${server}`;
  }
  if (tool === "submit") {
    const selector = (input.selector as string) || (input.locator as string) || "form";
    return `Submit ${selector} via ${server}`;
  }
  if (tool.startsWith("send_")) {
    const thing = toWords(tool.replace("send_", ""));
    const to = (input.to ?? input.recipient ?? input.user ?? null) as string | null;
    return `Send ${thing}${to ? ` to ${to}` : ""} via ${server}`;
  }
  if (tool.startsWith("create_")) {
    const thing = toWords(tool.replace("create_", ""));
    const name = (input.title ?? input.name ?? input.subject ?? null) as string | null;
    const preview = name ? ` "${name.length > 30 ? `${name.slice(0, 27)}...` : name}"` : "";
    return `Create ${thing}${preview} via ${server}`;
  }
  if (tool.startsWith("update_")) {
    const thing = toWords(tool.replace("update_", ""));
    const id = input.id ?? input[`${thing.replace(/ /g, "_")}_id`] ?? null;
    const numericId = id !== null && /^\d+$/.test(String(id)) ? String(id) : null;
    return `Update ${thing}${numericId ? ` #${numericId}` : ""} via ${server}`;
  }
  if (tool.startsWith("post_") || tool.startsWith("publish_")) {
    const verb = tool.startsWith("post_") ? "Post" : "Publish";
    const thing = toWords(tool.replace(/^(post|publish)_/, ""));
    const name = (input.title ?? input.name ?? input.tag ?? null) as string | null;
    return `${verb} ${thing}${name ? ` "${name}"` : ""} via ${server}`;
  }

  const action = tool.replace(/_/g, " ");
  return `${action.charAt(0).toUpperCase() + action.slice(1)} via ${server}`;
}

function toWords(snake: string): string {
  return snake.replace(/_/g, " ").split(" ").map((w) => (w.length <= 3 ? w.toUpperCase() : w)).join(" ");
}

function shortenPath(filePath: string): string {
  return filePath
    .replace(/^\/home\/[^/]+\//, "~/")
    .replace(/^\/Users\/[^/]+\//, "~/");
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function summarizeArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const summary = entries
    .map(([k, v]) => {
      const val = typeof v === "string" ? v.slice(0, 30) : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join(", ");
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
}
