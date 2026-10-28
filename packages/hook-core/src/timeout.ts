import { DEFAULT_APPROVAL_TIMEOUT_MS } from "@oked/sdk";

/**
 * Seconds a host should let the hook process run.
 *
 * Must stay above the SDK approval timeout. When the SDK times out it writes
 * a fail-safe deny. A host that kills the process first gets no output, and
 * most hosts then let the tool call continue. The 60 second margin covers
 * process spawn plus heartbeat() and getRules(), which both run before
 * approve() is called.
 *
 * 630 seconds of SDK wait plus 60 seconds is 690.
 */
export const HOOK_TIMEOUT_SECONDS = DEFAULT_APPROVAL_TIMEOUT_MS / 1000 + 60;
