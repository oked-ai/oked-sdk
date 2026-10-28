import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { hostname } from "os";
import { dirname } from "path";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { loadOKedConfig, OKED_CONFIG_PATH } from "@oked/sdk";
import { renderQR } from "./qr.js";

/** The first 8 characters, never the whole key. */
export function maskKey(key: string): string {
  return `${key.slice(0, 8)}...`;
}

export function writeOkedConfig(apiKey: string, backendUrl: string): void {
  const dir = dirname(OKED_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = loadOKedConfig();
  const payload = { ...existing, apiKey, backendUrl };
  writeFileSync(OKED_CONFIG_PATH, JSON.stringify(payload, null, 2) + "\n");
  try {
    chmodSync(OKED_CONFIG_PATH, 0o600);
  } catch {
    // Windows doesn't honor chmod; the file lives in the user profile anyway.
  }
}

function openBrowser(url: string): boolean {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // The launcher may fail asynchronously (e.g. xdg-open missing). Swallow it
    // so it can't crash the process; the URL is always printed as a fallback.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort copy to the OS clipboard. Resolves true only if a clipboard tool
 * actually accepted the text, so the "(copied to clipboard)" line never lies on
 * a headless box. Linux is tried via wl-copy (Wayland), then xclip, then xsel.
 * The code is always printed, so a failure here is purely cosmetic.
 */
function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === "darwin"
      ? [{ cmd: "pbcopy", args: [] }]
      : process.platform === "win32"
        ? [{ cmd: "clip", args: [] }]
        : [
            { cmd: "wl-copy", args: [] },
            { cmd: "xclip", args: ["-selection", "clipboard"] },
            { cmd: "xsel", args: ["--clipboard", "--input"] },
          ];

  const tryCopy = ({ cmd, args }: { cmd: string; args: string[] }): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      try {
        const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", () => done(false));
        child.on("close", (code) => done(code === 0));
        child.stdin?.on("error", () => {});
        child.stdin?.end(text);
      } catch {
        done(false);
      }
    });

  return candidates.reduce<Promise<boolean>>(
    (acc, cand) => acc.then((ok) => (ok ? true : tryCopy(cand))),
    Promise.resolve(false),
  );
}

/** Ask for Enter. cancel() takes the prompt away, for when pairing ends first. */
function waitForEnter(message: string): { pressed: Promise<void>; cancel: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(130);
  });
  const pressed = new Promise<void>((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
  return {
    pressed,
    cancel: () => {
      process.stdout.write("\n");
      rl.close();
    },
  };
}

export interface PairOptions {
  backendUrl: string;
  clientType: string;
  clientVersion: string;
  /** Print the link. Do not open a browser and do not touch the clipboard. */
  noBrowser?: boolean;
  /**
   * Line printed above the QR code. Claude Code keeps the historical sentence.
   * Other hosts should not imply the iPhone app is available.
   */
  scanLine?: string;
  /**
   * Two lines printed under the link. The default matches Claude Code.
   * Other hosts should say the iPhone app is coming soon.
   */
  footerLines?: [string, string];
  /** Command named when pairing expires. Default `oked init`. */
  retryCommand?: string;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

/** Poll until the code is confirmed (the API key), or it expires (null). */
async function pollForKey(
  backendUrl: string,
  code: { device_code: string; interval: number; expires_in: number },
  retryCommand: string,
): Promise<string | null> {
  const deadline = Date.now() + code.expires_in * 1000;
  const intervalMs = Math.max(1, code.interval) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollRes = await fetch(`${backendUrl}/api/v1/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: code.device_code }),
    });
    if (pollRes.status === 410) {
      console.log(`  Pairing code expired. Run \`${retryCommand}\` again.`);
      return null;
    }
    if (!pollRes.ok) continue;
    const body = (await pollRes.json()) as { status: string; api_key?: string };
    if (body.status === "approved" && body.api_key) {
      return body.api_key;
    }
  }
  console.log(`  Pairing timed out. Run \`${retryCommand}\` again.`);
  return null;
}

/**
 * Device pairing used by every `init` command. Prints the code, the link, and
 * (on a color TTY) a QR code, then polls until the key arrives. Returns the
 * API key, or null if pairing failed. The caller stores the key.
 */
export async function pairDevice(opts: PairOptions): Promise<string | null> {
  const codeRes = await fetch(`${opts.backendUrl}/api/v1/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_type: opts.clientType,
      hostname: hostname(),
      client_version: opts.clientVersion,
    }),
  });
  if (!codeRes.ok) {
    console.log(`  Failed to start pairing: ${codeRes.status} ${await codeRes.text()}`);
    return null;
  }
  const code = (await codeRes.json()) as DeviceCode;

  console.log("");
  console.log("  Pair this device with your OKed account.");
  console.log("");
  console.log("  Your pairing code:");
  console.log(`    ${code.user_code}`);
  if (!opts.noBrowser && (await copyToClipboard(code.user_code))) {
    console.log("    (copied to clipboard)");
  }
  console.log("");

  // The QR code holds the pairing link. The phone camera opens it in the browser.
  if (process.stdout.isTTY && !process.env.NO_COLOR) {
    console.log(opts.scanLine ?? "  Or scan this with your iPhone:");
    console.log("");
    console.log(renderQR(code.verification_uri_complete));
    console.log("");
  }

  const retryCommand = opts.retryCommand ?? "oked init";
  const paired = pollForKey(opts.backendUrl, code, retryCommand);

  const interactive =
    Boolean(process.stdin.isTTY) &&
    !process.argv.includes("--yes") &&
    !process.argv.includes("-y");
  if (interactive && !opts.noBrowser) {
    const enter = waitForEnter("  Press Enter to open your browser (Ctrl+C to cancel)... ");
    const first = await Promise.race([enter.pressed.then(() => "enter" as const), paired.then(() => "paired" as const)]);
    if (first === "paired") {
      enter.cancel();
      return paired;
    }
  }

  const opened = opts.noBrowser ? false : openBrowser(code.verification_uri_complete);
  console.log("");
  if (opened) {
    console.log("  Opened your browser to:");
  } else if (opts.noBrowser) {
    console.log("  Open this link:");
  } else {
    console.log("  Couldn't open your browser automatically. Open this link:");
  }
  console.log(`    ${code.verification_uri_complete}`);
  console.log("");
  const footer = opts.footerLines ?? [
    `  (Or visit ${code.verification_uri} and enter the code above,`,
    "  or enter it in the OKed app on your iPhone.)",
  ];
  console.log(footer[0]);
  console.log(footer[1]);
  console.log("");
  console.log("  Waiting for confirmation...");
  return paired;
}
