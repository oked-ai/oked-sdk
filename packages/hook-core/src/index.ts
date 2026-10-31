export { decide, type ToolCallInput, type DecideOptions, type GateDecision, type PermissionDecision } from "./decide.js";
export { HOOK_TIMEOUT_SECONDS } from "./timeout.js";
export {
  logDecision,
  errorInfo,
  OKED_HOOK_LOG,
  type DecisionLogEntry,
  type ErrorInfo,
} from "./log.js";
export {
  appendReceipt,
  verifyReceiptsFile,
  OKED_RECEIPTS_LOG,
  type LocalVerifyReport,
} from "./receipts.js";
export {
  findClaudeOkedHooks,
  listClaudeOkedCommands,
  settingsHasOkedHook,
  claudeUserSettingsPath,
  matcherCoversTool,
  commandIsResolvable,
  type ClaudeHookHit,
  type ClaudeHookScope,
  type ClaudeOkedCommand,
} from "./claude-hooks.js";
export {
  OKED_PLUGIN_NAME,
  OKED_PLUGIN_HOOK_FILE,
  isOkedPluginId,
  installedOkedRecords,
  resolveOkedPluginEnabled,
  loadInstalledOkedRecords,
  okedPluginIsEnabled,
  okedPluginBundleOnDisk,
  bundleExistsAt,
  settingsHookYieldsToPlugin,
  pluginHookYieldsToSettingsHook,
  type OkedInstallRecord,
  type OkedPluginResolution,
} from "./claude-plugin.js";
export {
  stringField,
  withNormalizedFields,
  asToolInput,
  shQuote,
  mapFileDelete,
  extractPatchPaths,
  mapPatch,
} from "./normalize.js";
export { pairDevice, writeOkedConfig, maskKey, type PairOptions } from "./pair.js";
export {
  claudeSandboxEnforced,
  readClaudeSandbox,
  exclusionCoversCommand,
  SANDBOX_INIT_HINT,
  type ClaudeSandboxView,
} from "./sandbox.js";
export { encodeQR, renderQR } from "./qr.js";
