/**
 * Device-code pairing for a gateway that has no API key.
 *
 * Same endpoints as `oked-openclaw init`: POST /api/v1/device/code, then
 * POST /api/v1/device/poll. One attempt per gateway start. The code is reused
 * until it expires. A completed pairing is handed to onApproved, which saves
 * the key the same way init does.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PairingState {
  phase: "starting" | "pending" | "approved" | "expired" | "unavailable";
  userCode?: string;
  pairUrl?: string;
  apiKey?: string;
}

export interface PairingSession {
  state: PairingState;
  /** Resolves when the pair URL is known, or when starting pairing failed. */
  ready: Promise<void>;
  /** Resolves when this attempt finishes (approved, expired, or unavailable). */
  settled: Promise<void>;
}

interface DeviceCodeBody {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri_complete?: unknown;
  interval?: unknown;
  expires_in?: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The gateway stays up for other reasons. A poll timer must not keep a
    // short-lived process alive after the last real handle closes.
    timer.unref?.();
  });
}

export function unpairedDenyReason(state: PairingState): string {
  const cli = "run `npx @oked/openclaw-cli init`";
  let how: string;
  if (state.phase === "expired") {
    how = `The pair code expired. ${cli}`;
  } else if (state.pairUrl && state.userCode) {
    how = `Open ${state.pairUrl} (code ${state.userCode}) or ${cli}`;
  } else if (state.pairUrl) {
    how = `Open ${state.pairUrl} or ${cli}`;
  } else {
    how = `Open the pair link from the gateway log or ${cli}`;
  }
  return (
    `OKed is not set up yet. ${how}. ` +
    `This action is denied until OKed is paired. ` +
    `Do NOT retry the same action. Stop and ask the user to finish setup.`
  );
}

export function okedConfigPath(home = homedir()): string {
  return path.join(home, ".oked", "config.json");
}

export function openclawConfigPath(home = homedir()): string {
  return path.join(home, ".openclaw", "openclaw.json");
}

function readObject(file: string): { value: Record<string, unknown>; writable: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, writable: true };
    }
    return { value: {}, writable: false };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { value: {}, writable: missing };
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not honor this mode. The file stays in the user profile.
  }
}

/**
 * Save a paired key the same way `oked-openclaw init` does:
 * ~/.oked/config.json, plus plugins.allow and plugins.entries.oked in
 * ~/.openclaw/openclaw.json. Never throws.
 */
export function persistPairedApiKey(
  apiKey: string,
  backendUrl: string,
  home = homedir(),
): { savedOkedConfig: boolean; savedOpenClawConfig: boolean } {
  const result = { savedOkedConfig: false, savedOpenClawConfig: false };
  try {
    const okedFile = okedConfigPath(home);
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(okedFile, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
    writeJson(okedFile, { ...existing, apiKey, backendUrl });
    result.savedOkedConfig = true;
  } catch {
    result.savedOkedConfig = false;
  }

  try {
    const openclawFile = openclawConfigPath(home);
    const loaded = readObject(openclawFile);
    if (!loaded.writable) return result;
    const cfg = loaded.value;
    const plugins =
      cfg.plugins && typeof cfg.plugins === "object" && !Array.isArray(cfg.plugins)
        ? (cfg.plugins as Record<string, unknown>)
        : {};
    const allow = Array.isArray(plugins.allow) ? [...plugins.allow] : [];
    if (!allow.includes("oked")) allow.push("oked");
    plugins.allow = allow;
    const entries =
      plugins.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
        ? (plugins.entries as Record<string, unknown>)
        : {};
    const prev =
      entries.oked && typeof entries.oked === "object" && !Array.isArray(entries.oked)
        ? (entries.oked as Record<string, unknown>)
        : {};
    entries.oked = { ...prev, enabled: true, apiKey, backendUrl };
    plugins.entries = entries;
    cfg.plugins = plugins;
    writeJson(openclawFile, cfg);
    result.savedOpenClawConfig = true;
  } catch {
    result.savedOpenClawConfig = false;
  }
  return result;
}

function pairUrlFromCode(code: DeviceCodeBody, userCode: string): string {
  if (typeof code.verification_uri_complete === "string" && code.verification_uri_complete) {
    return code.verification_uri_complete;
  }
  return `https://app.oked.ai/pair?code=${encodeURIComponent(userCode)}`;
}

/**
 * Start device pairing once. Call this once per gateway start.
 * pollIntervalMs overrides the server interval (tests). Production omits it
 * and waits the server interval, at least one second.
 */
export function beginDevicePairing(opts: {
  backendUrl: string;
  clientVersion: string;
  hostname: string;
  log: (line: string) => void;
  onApproved: (apiKey: string) => void;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}): PairingSession {
  const state: PairingState = { phase: "starting" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.backendUrl.replace(/\/$/, "");
  let resolveReady: () => void = () => {};
  let resolveSettled: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const finishReady = () => resolveReady();
  const finishSettled = () => {
    finishReady();
    resolveSettled();
  };

  const poll = async (deviceCode: string, intervalSec: number, expiresSec: number) => {
    const deadline = Date.now() + expiresSec * 1000;
    const intervalMs =
      opts.pollIntervalMs !== undefined ? opts.pollIntervalMs : Math.max(1, intervalSec || 3) * 1000;
    while (Date.now() < deadline && state.phase === "pending") {
      await delay(intervalMs);
      if (state.phase !== "pending") return;
      let pollRes: Response;
      try {
        pollRes = await fetchImpl(`${base}/api/v1/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        continue;
      }
      if (pollRes.status === 410) {
        state.phase = "expired";
        opts.log("[oked] Pairing code expired. Run `npx @oked/openclaw-cli init`.");
        return;
      }
      if (!pollRes.ok) continue;
      let body: { status?: unknown; api_key?: unknown };
      try {
        body = (await pollRes.json()) as { status?: unknown; api_key?: unknown };
      } catch {
        continue;
      }
      if (body.status === "approved" && typeof body.api_key === "string" && body.api_key) {
        state.phase = "approved";
        state.apiKey = body.api_key;
        try {
          opts.onApproved(body.api_key);
        } catch {
          // The key is still on state.apiKey for this process.
        }
        opts.log("[oked] Paired. This gateway will use the new API key.");
        return;
      }
    }
    if (state.phase === "pending") {
      state.phase = "expired";
      opts.log("[oked] Pairing timed out. Run `npx @oked/openclaw-cli init`.");
    }
  };

  void (async () => {
    try {
      const res = await fetchImpl(`${base}/api/v1/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_type: "openclaw",
          hostname: opts.hostname,
          client_version: opts.clientVersion,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        state.phase = "unavailable";
        opts.log(
          `[oked] OKed is not set up yet. Pairing did not start (${res.status}). ` +
            "Run `npx @oked/openclaw-cli init`. Sensitive tool calls are denied until then.",
        );
        finishSettled();
        return;
      }
      const code = (await res.json()) as DeviceCodeBody;
      if (typeof code.device_code !== "string" || typeof code.user_code !== "string" || !code.user_code) {
        state.phase = "unavailable";
        opts.log(
          "[oked] OKed is not set up yet. Pairing did not start. " +
            "Run `npx @oked/openclaw-cli init`. Sensitive tool calls are denied until then.",
        );
        finishSettled();
        return;
      }
      state.phase = "pending";
      state.userCode = code.user_code;
      state.pairUrl = pairUrlFromCode(code, code.user_code);
      opts.log(
        `[oked] OKed is not set up yet. Open ${state.pairUrl} (code ${state.userCode}) ` +
          "or run `npx @oked/openclaw-cli init`. Sensitive tool calls are denied until pairing finishes.",
      );
      finishReady();
      const interval = typeof code.interval === "number" ? code.interval : 3;
      const expires = typeof code.expires_in === "number" ? code.expires_in : 600;
      await poll(code.device_code, interval, expires);
      finishSettled();
    } catch {
      state.phase = "unavailable";
      opts.log(
        "[oked] OKed is not set up yet. Pairing did not start. " +
          "Run `npx @oked/openclaw-cli init`. Sensitive tool calls are denied until then.",
      );
      finishSettled();
    }
  })();

  return { state, ready, settled };
}
