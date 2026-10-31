import { createInterface } from "readline";
import {
  formatWatchReport,
  loadOKedConfig,
  parseOkedMode,
  saveOkedMode,
  type OkedMode,
} from "@oked/sdk";

export interface InstallModeChoice {
  mode: OkedMode;
  /** True when this run should write `mode` into ~/.oked/config.json. */
  persist: boolean;
  source: "flag" | "env" | "config" | "prompt" | "default";
}

/** `--mode watch` or `--mode enforce`. A missing or unknown value is not a mode. */
export function modeFromArgv(argv: readonly string[]): OkedMode | undefined {
  const index = argv.indexOf("--mode");
  if (index === -1) return undefined;
  return parseOkedMode(argv[index + 1]);
}

function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(130);
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * How `init` picks a mode.
 * `--mode` wins, then OKED_MODE, then a mode already in the config file.
 * A terminal with no choice yet asks. Anything else leaves the default
 * (enforce) and does not write the file, so a non-interactive re-run does
 * not change an existing install.
 */
export async function chooseInstallMode(options?: {
  argv?: readonly string[];
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}): Promise<InstallModeChoice> {
  const argv = options?.argv ?? process.argv;
  const flagged = modeFromArgv(argv);
  if (flagged) return { mode: flagged, persist: true, source: "flag" };
  if (argv.includes("--mode")) {
    const index = argv.indexOf("--mode");
    const raw = argv[index + 1] ?? "";
    console.error(`Ignoring --mode ${raw}. Use watch or enforce.`);
  }
  const env = parseOkedMode(process.env.OKED_MODE);
  if (env) return { mode: env, persist: true, source: "env" };
  const saved = parseOkedMode(loadOKedConfig().mode);
  if (saved) return { mode: saved, persist: false, source: "config" };
  const tty = options?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (tty) {
    const ask = options?.prompt ?? askOnTerminal;
    const answer = (
      await ask(
        "Mode: watch lets risky actions run and records what OKed would have paused. enforce pauses them. [enforce] ",
      )
    )
      .trim()
      .toLowerCase();
    return { mode: parseOkedMode(answer) ?? "enforce", persist: true, source: "prompt" };
  }
  return { mode: "enforce", persist: false, source: "default" };
}

export function modeBlurb(mode: OkedMode): string {
  return mode === "watch"
    ? "  Mode: watch (risky actions run, and OKed records what it would have paused)"
    : "  Mode: enforce (risky actions pause until you approve)";
}

/** Resolve the install mode, save it when the user chose one, and print one line. */
export async function applyInstallMode(): Promise<OkedMode> {
  const choice = await chooseInstallMode();
  if (choice.persist) saveOkedMode(choice.mode);
  console.log(modeBlurb(choice.mode));
  return choice.mode;
}

export function printWatchReport(): void {
  const text = formatWatchReport();
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}
