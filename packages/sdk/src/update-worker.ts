// Detached worker invoked by triggerBackgroundUpdate(). Runs a single update
// check and exits. Failures are swallowed and recorded to update.json.
import { runUpdate } from "./update.js";

runUpdate().catch(() => {
  /* swallow; runUpdate already persists errors to update.json */
});
