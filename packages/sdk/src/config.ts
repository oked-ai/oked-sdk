import { homedir } from "os";
import { join } from "path";

export const OKED_RULES_CACHE_PATH = join(homedir(), ".oked", "rules-cache.json");
export const OKED_HEARTBEAT_PATH = join(homedir(), ".oked", "heartbeat.json");
export const OKED_RECEIPT_KEYS_PATH = join(homedir(), ".oked", "receipt-keys.json");
