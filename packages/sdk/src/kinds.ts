/**
 * Stable taxonomy of operations the SDK recognizes. Used as the
 * `operation_kind` analytics column on approval_classifications.
 *
 * Bump CLASSIFIER_VERSION when you add/remove kinds or change how a
 * pattern maps to a kind, so historical rows stay attributable to the
 * classifier that produced them.
 */

export const CLASSIFIER_VERSION = "v1";

export type OperationKind =
  // File operations
  | "file_create" | "file_append" | "file_edit" | "file_touch"
  | "file_copy" | "file_move" | "file_delete"
  // SQL
  | "sql_drop" | "sql_truncate" | "sql_alter" | "sql_create"
  | "sql_delete_rows" | "sql_delete_all_rows"
  | "sql_update_rows" | "sql_update_every_row"
  | "sql_insert" | "sql_query"
  // Git
  | "git_push" | "git_force_push" | "git_reset_hard"
  | "git_clean" | "git_checkout" | "git_restore" | "git_commit"
  // HTTP via shell
  | "http_get" | "http_post" | "http_put" | "http_delete"
  | "http_pipe_to_shell"
  // Docker
  | "docker_up" | "docker_down" | "docker_rm" | "docker_rmi" | "docker_prune"
  // npm / npx
  | "npm_install" | "npm_run" | "npm_test"
  | "npm_publish" | "npm_unpublish" | "npx_deploy"
  // System / privilege
  | "kill_process" | "sudo" | "chmod_777"
  // Communication / commerce
  | "email_send" | "email_delete" | "email_purge"
  | "payment_charge" | "payment_create" | "chat_message"
  // MCP categories
  | "mcp_delete" | "mcp_update" | "mcp_create"
  | "mcp_post" | "mcp_publish"
  | "mcp_send" | "mcp_submit_form" | "mcp_fill" | "mcp_submit" | "mcp_query"
  // Agents
  | "agent_launch"
  // Shell composite / fallbacks
  | "shell_pipeline"
  | "unknown_bash" | "unknown_tool";
