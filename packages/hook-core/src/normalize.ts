import { classify, TIER_ORDER, type RiskTier } from "@oked/sdk";

/** First string value among `keys`, if any. */
export function stringField(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

const FILE_KEYS = ["file_path", "filePath", "path", "target_file", "targetFile", "file"] as const;
const CONTENT_KEYS = ["content", "contents", "data", "text", "new_string", "newString"] as const;
const COMMAND_KEYS = ["command", "cmd", "script"] as const;

/**
 * Copy host-specific argument names onto the fields `classify` and `describe`
 * already read (`file_path`, `content`, `command`). The original keys stay.
 */
export function withNormalizedFields(input: Record<string, unknown>): Record<string, unknown> {
  const file_path = stringField(input, FILE_KEYS);
  const content = stringField(input, CONTENT_KEYS);
  const command = stringField(input, COMMAND_KEYS);
  return {
    ...input,
    ...(file_path !== undefined ? { file_path } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(command !== undefined ? { command } : {}),
  };
}

/** Turn a host tool-args value into an object. A raw string is a command. */
export function asToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through and treat the text as a command.
      }
    }
    return { command: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Shell-safe single quotes. The result is classified, never executed. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A file delete, expressed as `rm` so the SDK's bash classifier can tell a
 * temp file from a real one. No path stays an unknown tool (approval required).
 */
export function mapFileDelete(input: Record<string, unknown>): {
  toolName: string;
  toolInput: Record<string, unknown>;
} {
  const normalized = withNormalizedFields(input);
  const filePath = typeof normalized.file_path === "string" ? normalized.file_path : "";
  if (!filePath) return { toolName: "Delete", toolInput: normalized };
  return { toolName: "Bash", toolInput: { command: `rm -- ${shQuote(filePath)}` } };
}

interface PatchFiles {
  writes: string[];
  deletes: string[];
}

/**
 * Paths named by a Codex-style apply_patch body or a unified diff.
 * Used only to pick a tier. The patch is not applied here.
 */
export function extractPatchPaths(patch: string): PatchFiles {
  const writes: string[] = [];
  const deletes: string[] = [];
  const add = (list: string[], raw: string) => {
    const path = raw.trim().replace(/^"(.*)"$/, "$1");
    if (path && path !== "/dev/null") list.push(path);
  };
  for (const line of patch.split(/\r?\n/)) {
    const named = line.match(/^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(.+)$/);
    if (named) {
      add(named[1] === "Delete" ? deletes : writes, named[2]);
      continue;
    }
    const diffGit = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffGit) add(writes, diffGit[2]);
    const plus = line.match(/^\+\+\+ (?!\/dev\/null )(?:b\/)?(.+)$/);
    if (plus) add(writes, plus[1]);
    const minus = line.match(/^--- (?!\/dev\/null )(?:a\/)?(.+)$/);
    if (minus && /deleted file mode/.test(patch)) add(deletes, minus[1]);
  }
  const delMode = patch.match(/^diff --git a\/(.+?) b\/.+\n(?:.*\n)*?deleted file mode /m);
  if (delMode) add(deletes, delMode[1]);
  return { writes, deletes };
}

/**
 * Map a patch onto one SDK tool call whose tier matches the riskiest file.
 * Deletes become `rm`. Writes and updates become `Write` (warning inside a
 * project, review on a sensitive path). An unreadable patch is an unknown
 * edit, which the classifier sends to approval.
 */
export function mapPatch(patch: string): { toolName: string; toolInput: Record<string, unknown> } {
  const { writes, deletes } = extractPatchPaths(patch);
  let best: { toolName: string; toolInput: Record<string, unknown>; tier: RiskTier } | null = null;
  const consider = (
    current: typeof best,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): NonNullable<typeof best> => {
    const tier = classify(toolName, toolInput);
    if (!current || TIER_ORDER[tier] > TIER_ORDER[current.tier]) {
      return { toolName, toolInput, tier };
    }
    return current;
  };
  if (deletes.length > 0) {
    best = consider(best, "Bash", { command: `rm -- ${deletes.map(shQuote).join(" ")}` });
  }
  for (const file_path of writes) {
    best = consider(best, "Write", { file_path, content: patch });
  }
  if (!best) return { toolName: "Edit", toolInput: { file_path: "" } };
  return { toolName: best.toolName, toolInput: best.toolInput };
}
