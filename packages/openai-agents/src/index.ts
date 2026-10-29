/**
 * @oked/openai-agents. Human approval for tools built with @openai/agents.
 *
 * okedTool() and withOkedTools() gate a tool before it runs. settleOkedInterruptions()
 * resolves the SDK's own needsApproval pause. Denied, timed out, and failed
 * approvals stop the tool and return a reason to the model.
 */
export { OkedToolDeniedError } from "./messages.js";
export type { OkedDenial, OkedStopDecision } from "./messages.js";
export { OKED_TOOL_TIMEOUT_FLOOR_MS, toolTimeoutFloor } from "./gate.js";
export type { OkedAgentsConfig } from "./gate.js";
export { okedTool, withOkedTools, settleOkedInterruptions } from "./wrap.js";
export type { OkedRunLike } from "./wrap.js";
