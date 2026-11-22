/**
 * Anonymous install ping for an unpaired OpenClaw gateway.
 *
 * One request per install id, on the first gateway start that has no API key.
 * The body is only client_type, plugin version, OpenClaw version, and a random
 * id stored on this machine. No hostname, no API key, no tool arguments.
 * OKED_TELEMETRY=0 skips the request. Failures are silent.
 *
 * The backend endpoint is POST /api/v1/install. This repo does not contain the
 * backend. The client sends the payload below and ignores the response except
 * for the HTTP status.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const INSTALL_PING_PATH = "/api/v1/install";

export interface InstallPingPayload {
  client_type: "openclaw";
  plugin_version: string;
  openclaw_version: string;
  install_id: string;
}

interface InstallState {
  installId: string;
  sentAt?: string;
}

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OKED_TELEMETRY;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

export function defaultInstallStateFile(home = homedir()): string {
  return path.join(home, ".oked", "openclaw-install.json");
}

function readState(file: string): InstallState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { installId?: unknown; sentAt?: unknown };
    if (!parsed || typeof parsed.installId !== "string" || !parsed.installId) return undefined;
    const state: InstallState = { installId: parsed.installId };
    if (typeof parsed.sentAt === "string" && parsed.sentAt) state.sentAt = parsed.sentAt;
    return state;
  } catch {
    return undefined;
  }
}

function writeState(file: string, state: InstallState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload: InstallState = { installId: state.installId };
  if (state.sentAt) payload.sentAt = state.sentAt;
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not honor this mode. The file stays in the user profile.
  }
}

/**
 * Send the anonymous install ping once for this install id.
 * Returns the payload when a request was attempted, otherwise undefined.
 * Never throws.
 */
export async function sendAnonymousInstallPing(opts: {
  backendUrl: string;
  pluginVersion: string;
  openclawVersion: string;
  stateFile?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallPingPayload | undefined> {
  try {
    if (!telemetryEnabled(opts.env ?? process.env)) return undefined;
    const stateFile = opts.stateFile ?? defaultInstallStateFile();
    const existing = readState(stateFile);
    if (existing?.sentAt) return undefined;
    const state: InstallState = { installId: existing?.installId || randomUUID() };
    const payload: InstallPingPayload = {
      client_type: "openclaw",
      plugin_version: opts.pluginVersion,
      openclaw_version: opts.openclawVersion || "unknown",
      install_id: state.installId,
    };
    try {
      writeState(stateFile, state);
    } catch {
      // A missing state file means a later start may generate a new id.
    }
    const base = opts.backendUrl.replace(/\/$/, "");
    const res = await (opts.fetchImpl ?? fetch)(`${base}${INSTALL_PING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      try {
        writeState(stateFile, { ...state, sentAt: new Date().toISOString() });
      } catch {
        // The request landed. A later start may send the same id once more.
      }
    }
    return payload;
  } catch {
    return undefined;
  }
}
