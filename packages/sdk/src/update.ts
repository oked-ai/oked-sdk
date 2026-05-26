import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SDK_VERSION, DEFAULT_MANIFEST_URL } from "./version.js";

export interface ReleaseFile {
  // Filename written into versions/<v>/, e.g. "oked-hook.js".
  name: string;
  url: string;
  sha256: string;
  size?: number;
}

export interface Manifest {
  version: string;
  files: ReleaseFile[];
  publishedAt?: string;
  disableAutoUpdate?: boolean;
}

export interface UpdateState {
  lastCheck?: number;
  lastError?: string;
  latestKnownVersion?: string;
  pinnedVersion?: string;
  disableAutoUpdate?: boolean;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 10_000;
const KEEP_VERSIONS = 2;

export function getOkedHome(): string {
  return process.env.OKED_HOME || join(homedir(), ".oked");
}

function versionsDir(): string {
  return join(getOkedHome(), "versions");
}

function currentLinkPath(): string {
  return join(getOkedHome(), "current");
}

function updateStatePath(): string {
  return join(getOkedHome(), "update.json");
}

function lockPath(): string {
  return join(getOkedHome(), "update.lock");
}

export function readUpdateState(): UpdateState {
  try {
    const raw = readFileSync(updateStatePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeUpdateState(patch: Partial<UpdateState>): void {
  const current = readUpdateState();
  const merged = { ...current, ...patch };
  mkdirSync(getOkedHome(), { recursive: true });
  writeFileSync(updateStatePath(), JSON.stringify(merged, null, 2) + "\n");
}

// Returns the path of the active managed install, or null if none.
export function getCurrentManagedDir(): string | null {
  const link = currentLinkPath();
  if (!existsSync(link)) return null;
  try {
    return realpathSync(link);
  } catch {
    return null;
  }
}

// Returns the version string of the active managed install, or null.
export function getCurrentManagedVersion(): string | null {
  const dir = getCurrentManagedDir();
  if (!dir) return null;
  try {
    return readFileSync(join(dir, "VERSION"), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

// Returns the version the running process is using: managed > built-in.
export function getRunningVersion(): string {
  return getCurrentManagedVersion() || SDK_VERSION;
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, baseline: string): boolean {
  return compareSemver(candidate, baseline) > 0;
}

// Acquire an exclusive on-disk lock. Stale locks (>10min) are reclaimed.
function tryAcquireLock(): number | null {
  mkdirSync(getOkedHome(), { recursive: true });
  const path = lockPath();
  try {
    const fd = openSync(path, "wx");
    writeFileSync(path, String(process.pid));
    return fd;
  } catch {
    try {
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > 10 * 60 * 1000) {
        unlinkSync(path);
        return tryAcquireLock();
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

function releaseLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath());
  } catch {
    /* ignore */
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": `oked-sdk/${SDK_VERSION}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

export async function fetchManifest(url?: string): Promise<Manifest> {
  const u = url || process.env.OKED_RELEASE_MANIFEST_URL || DEFAULT_MANIFEST_URL;
  const json = (await fetchJson(u, MANIFEST_TIMEOUT_MS)) as Manifest;
  if (!json || typeof json.version !== "string" || !Array.isArray(json.files)) {
    throw new Error("Malformed manifest");
  }
  return json;
}

async function downloadToFile(url: string, dest: string, expectedSha: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": `oked-sdk/${SDK_VERSION}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const out = createWriteStream(tmp);
  const hash = createHash("sha256");
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once("drain", () => r()));
      }
    }
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  const got = hash.digest("hex");
  if (got.toLowerCase() !== expectedSha.toLowerCase()) {
    unlinkSync(tmp);
    throw new Error(`SHA-256 mismatch for ${url} (got ${got}, expected ${expectedSha})`);
  }
  renameSync(tmp, dest);
}

// Cross-platform "atomic" replace of the `current` symlink to point at `target`.
// On Windows we use a junction (directory link, works without admin).
function swapCurrentLink(targetDir: string): void {
  const link = currentLinkPath();
  const tmp = `${link}.new`;
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(targetDir, tmp, linkType);
  try {
    renameSync(tmp, link);
  } catch (err) {
    // rename onto an existing symlink can fail on some Windows builds;
    // fall back to unlink + symlink.
    try {
      unlinkSync(link);
    } catch {
      /* ignore */
    }
    symlinkSync(targetDir, link, linkType);
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    void err;
  }
}

function garbageCollect(keepVersion: string): void {
  let entries: string[];
  try {
    entries = readdirSync(versionsDir());
  } catch {
    return;
  }
  const versions = entries
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .sort((a, b) => compareSemver(b, a));
  const keep = new Set<string>([keepVersion, ...versions.slice(0, KEEP_VERSIONS)]);
  for (const v of versions) {
    if (keep.has(v)) continue;
    try {
      rmSync(join(versionsDir(), v), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface UpdateResult {
  status: "updated" | "up-to-date" | "skipped" | "pinned" | "disabled" | "locked" | "error";
  installedVersion: string;
  manifestVersion?: string;
  error?: string;
}

// Perform an update check and (if needed) install the new version.
// Safe to call concurrently — one caller acquires the lock; others get "locked".
export async function runUpdate(opts: { force?: boolean; manifestUrl?: string } = {}): Promise<UpdateResult> {
  const state = readUpdateState();
  const installed = getRunningVersion();

  if (state.disableAutoUpdate && !opts.force) {
    return { status: "disabled", installedVersion: installed };
  }
  if (state.pinnedVersion && !opts.force) {
    return { status: "pinned", installedVersion: installed, manifestVersion: state.pinnedVersion };
  }
  if (
    !opts.force &&
    state.lastCheck &&
    Date.now() - state.lastCheck < FOUR_HOURS_MS
  ) {
    return { status: "skipped", installedVersion: installed };
  }

  const lock = tryAcquireLock();
  if (lock === null) {
    return { status: "locked", installedVersion: installed };
  }

  try {
    let manifest: Manifest;
    try {
      manifest = await fetchManifest(opts.manifestUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeUpdateState({ lastCheck: Date.now(), lastError: msg });
      return { status: "error", installedVersion: installed, error: msg };
    }

    writeUpdateState({
      lastCheck: Date.now(),
      latestKnownVersion: manifest.version,
      disableAutoUpdate: manifest.disableAutoUpdate || undefined,
      lastError: undefined,
    });

    if (manifest.disableAutoUpdate) {
      return { status: "disabled", installedVersion: installed, manifestVersion: manifest.version };
    }

    if (!isNewerVersion(manifest.version, installed)) {
      return { status: "up-to-date", installedVersion: installed, manifestVersion: manifest.version };
    }

    const versionDir = join(versionsDir(), manifest.version);
    const stagingDir = `${versionDir}.partial`;
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    mkdirSync(stagingDir, { recursive: true });

    for (const file of manifest.files) {
      const dest = join(stagingDir, file.name);
      await downloadToFile(file.url, dest, file.sha256);
    }
    writeFileSync(join(stagingDir, "VERSION"), manifest.version + "\n");

    try {
      rmSync(versionDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    renameSync(stagingDir, versionDir);
    swapCurrentLink(versionDir);
    garbageCollect(manifest.version);

    return { status: "updated", installedVersion: installed, manifestVersion: manifest.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeUpdateState({ lastError: msg });
    return { status: "error", installedVersion: installed, error: msg };
  } finally {
    releaseLock(lock);
  }
}

// Roll the current symlink back to the next-newest installed version.
export function rollback(): { from: string | null; to: string | null } {
  const from = getCurrentManagedVersion();
  let entries: string[];
  try {
    entries = readdirSync(versionsDir());
  } catch {
    return { from, to: null };
  }
  const candidates = entries
    .filter((name) => /^\d+\.\d+\.\d+/.test(name) && name !== from)
    .sort((a, b) => compareSemver(b, a));
  const to = candidates[0];
  if (!to) return { from, to: null };
  swapCurrentLink(join(versionsDir(), to));
  return { from, to };
}

// Fire-and-forget: spawn the update worker as a detached process so the
// calling CLI can exit immediately without holding it open.
export function triggerBackgroundUpdate(): void {
  try {
    const state = readUpdateState();
    if (state.disableAutoUpdate || state.pinnedVersion) return;
    if (state.lastCheck && Date.now() - state.lastCheck < FOUR_HOURS_MS) return;

    // Worker name depends on the install:
    //   - npm install: dist/update-worker.js (sibling of this compiled update.js)
    //   - managed install: oked-update-worker.js (sibling in ~/.oked/current/)
    const candidates = [
      fileURLToPath(new URL("./update-worker.js", import.meta.url)),
      fileURLToPath(new URL("./oked-update-worker.js", import.meta.url)),
    ];
    const workerPath = candidates.find((p) => existsSync(p));
    if (!workerPath) return;
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OKED_UPDATE_WORKER: "1" },
    });
    child.unref();
  } catch {
    // The hot path must never fail because of update plumbing.
  }
}

// Returns a one-line "you're stale" message if the cached manifest reports a
// newer version than what's running. Returns null otherwise. Pure local read,
// no network call — populated by previous background worker runs.
export function staleVersionNag(): string | null {
  const state = readUpdateState();
  if (!state.latestKnownVersion) return null;
  const running = getRunningVersion();
  if (!isNewerVersion(state.latestKnownVersion, running)) return null;
  return `[OKed] A newer version is available: ${state.latestKnownVersion} (you have ${running}). Run \`oked update\` to upgrade.`;
}
