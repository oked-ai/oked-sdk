#!/usr/bin/env node
import {
  OKedClient,
  classify,
  describe,
  describeFields,
  degradedDecision,
  triggerBackgroundUpdate,
  OKedAuthError,
  OKedBackendUnreachableError,
} from "@oked/sdk";
import type { HookInput, HookOutput } from "@oked/sdk";

function makeOutput(
  decision: "allow" | "deny" | "ask",
  reason?: string
): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason && { permissionDecisionReason: reason }),
    },
  };
}

function log(msg: string): void {
  process.stderr.write(`[OKed] ${msg}\n`);
}

async function main(): Promise<void> {
  // Read hook input from stdin
  let rawInput = "";
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    // Can't parse input - don't break Claude, let it through
    process.stdout.write(JSON.stringify(makeOutput("allow")));
    return;
  }

  const { tool_name: toolName, tool_input: toolInput } = input;

  // Classify risk
  const tier = classify(toolName, toolInput);

  // Safe tools - allow immediately, no network call
  if (tier === "safe") {
    process.stdout.write(JSON.stringify(makeOutput("allow")));
    return;
  }

  // Warning - allow through, log to terminal only, no network call
  if (tier === "warning") {
    const summary = (toolInput.file_path ?? toolInput.command ?? toolName) as string;
    process.stderr.write(`WARNING  OKed: ${toolName} ${summary} - allowed (inside project)\n`);
    process.stdout.write(JSON.stringify(makeOutput("allow")));
    return;
  }

  // Check if API key is configured
  const client = new OKedClient();
  if (!client.apiKey) {
    log("not paired - run `oked init` to pair this device. Falling back to Claude's built-in prompt.");
    process.stdout.write(JSON.stringify(makeOutput("ask")));
    return;
  }

  // Generate human-readable description
  const description = describe(toolName, toolInput);
  const fields = describeFields(toolName, toolInput) ?? undefined;
  log(`${toolName}: "${description}" - ${tier}`);
  log("Requesting approval... (check your phone)");

  try {
    const result = await client.approve({
      action: toolName,
      description,
      tier,
      fields,
      tool_input: toolInput,
      session_id: input.session_id,
      cwd: input.cwd,
    });

    if (result.approved) {
      log(`Approved (${result.approval_id})`);
      process.stdout.write(
        JSON.stringify(makeOutput("allow", `Approved via OKed`))
      );
    } else {
      log(`Denied (${result.approval_id})`);
      process.stdout.write(
        JSON.stringify(
          makeOutput("deny", `Denied via OKed: ${description}`)
        )
      );
    }
  } catch (err) {
    if (err instanceof OKedAuthError) {
      // Auth misconfig is not an outage - always deny.
      log(`Invalid API key - action denied`);
      process.stdout.write(
        JSON.stringify(makeOutput("deny", "OKed: invalid API key"))
      );
    } else if (err instanceof OKedBackendUnreachableError) {
      const decision = degradedDecision(tier, {
        strictFailClosed: client.strictFailClosed,
      });
      if (decision === "allow") {
        log(`Backend unreachable - allowed (degraded; ${tier}, non-high-stakes)`);
        process.stdout.write(
          JSON.stringify(
            makeOutput(
              "allow",
              "OKed backend unreachable - allowed (degraded; non-high-stakes)"
            )
          )
        );
      } else {
        const why = client.strictFailClosed
          ? "strict fail-closed"
          : "high-stakes";
        log(`Backend unreachable - ${why} denied (fail-safe)`);
        process.stdout.write(
          JSON.stringify(
            makeOutput(
              "deny",
              `OKed backend unreachable - ${why} denied (fail-safe)`
            )
          )
        );
      }
    } else {
      // Unknown error - fail safe deny.
      log(`Unexpected error - action denied (fail-safe)`);
      process.stdout.write(
        JSON.stringify(
          makeOutput("deny", "OKed: unexpected error (fail-safe)")
        )
      );
    }
  }
}

main()
  .catch((err) => {
    process.stderr.write(`[OKed] Fatal: ${err}\n`);
    // Fail-safe: deny
    process.stdout.write(
      JSON.stringify(makeOutput("deny", "OKed: internal error (fail-safe)"))
    );
    process.exit(0); // exit 0 so Claude reads our JSON, not a crash
  })
  .finally(() => {
    // After the decision has been written, kick off a detached update check.
    // The worker outlives this process; we never wait on it.
    try {
      triggerBackgroundUpdate();
    } catch {
      /* never let update plumbing affect the hot path */
    }
  });
