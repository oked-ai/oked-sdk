# @oked/openclaw

[![npm version](https://img.shields.io/npm/v/@oked/openclaw.svg)](https://www.npmjs.com/package/@oked/openclaw)
[![License: Apache-2.0](https://img.shields.io/npm/l/@oked/openclaw.svg)](./LICENSE)

OKed pauses risky OpenClaw actions, like `rm -rf`, force-push, destructive SQL, and production deploys, until you approve them in Telegram or on the [web dashboard](https://oked.ai/dashboard). Reads and other ordinary actions just run. OKed is free during beta, and every decision gets a signed receipt. The iPhone app is coming soon.

A `before_tool_call` hook runs for every tool the host reports (built-in or registered by a skill) and classifies it. Calls at `review` and `high_stakes` wait until you decide. A denial returns `{ block: true, blockReason }`.

OpenClaw 2026.5.4 or newer is required. That release treats the returned denial as a veto and shows the reason to the agent. An earlier host ignored the return and ran the tool. The declared floor is `>=2026.5.4` on `peerDependencies.openclaw`, `engines.openclaw`, `openclaw.compat.pluginApi`, and `openclaw.install.minHostVersion`. `openclaw.compat.minGatewayVersion` and `openclaw.build.openclawVersion` are `2026.5.4` (2026.5.4 and newer).

## Install

Install from npm:

```bash
openclaw plugins install npm:@oked/openclaw
```

Once the package is listed on ClawHub, `openclaw plugins install @oked/openclaw` installs it from there.

Pair this machine with [`@oked/openclaw-cli`](../openclaw-cli). The CLI needs the `openclaw` command on your PATH. It pairs this device (or reuses an existing API key), sets `minTier` (a terminal prompt when none is set), writes the entry into `~/.openclaw/openclaw.json`, and offers to restart the gateway.

```bash
npm install -g @oked/openclaw-cli
oked-openclaw init
```

If this package is not already installed, and there is no local checkout, `oked-openclaw init` tries `openclaw plugins install @oked/openclaw` (ClawHub). If that fails, it retries `openclaw plugins install npm:@oked/openclaw`. A checkout or a global npm copy is still linked with `openclaw plugins install --link`.

To wire the config by hand after the plugin install, edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["oked"],
    "entries": {
      "oked": {
        "enabled": true,
        "apiKey": "ok_...",
        "minTier": "review"
      }
    }
  }
}
```

Restart the OpenClaw gateway after a manual edit. [Sign up](https://oked.ai/signup) if you do not have a key yet. The same dashboard is also served at [app.oked.ai/dashboard](https://app.oked.ai/dashboard/).

## Configuration

Keys live under `plugins.entries.oked`. The plugin manifest sets `additionalProperties: false`, so unknown keys are rejected. `OKED_STRICT_FAIL_CLOSED` is read from the environment, not from this object. `OKED_SEND_SCRIPT_CONTENT` is the environment form of `sendScriptContent`. A boolean in this object wins when both are set.

| Key | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `OKED_API_KEY` env | OKed API key. Required. With no key, sensitive calls are denied. |
| `minTier` | `"safe" \| "warning" \| "review" \| "high_stakes"` | `"review"` | Lowest tier that can ask for approval. `warning` never blocks: only `review` and `high_stakes` do. Env `OKED_MIN_TIER` is the fallback when the config value is absent. |
| `alwaysApprove` | `string[]` | `[]` | Tool names that are always `high_stakes`, whatever the classifier says. |
| `alwaysAllow` | `string[]` | `[]` | Tool names that are always `safe`. Use sparingly. |
| `timeoutMs` | `number` | `630000` | Per-approval wait, in milliseconds (10.5 minutes, so the backend's 10 minute expiry answers first). Minimum `1000`, maximum `1800000`. |
| `sendScriptContent` | `boolean` | `true` | Attach the first 4,096 bytes of a recognized local script so you can see what will run. Set `false` to omit it. Env `OKED_SEND_SCRIPT_CONTENT=0` (or `false`) does the same when this key is absent. |

## What gets gated

Names are matched against OpenClaw skill conventions, then unknown names default to `review`.

- **High stakes** (always an approval at the default `minTier`): names that send, post, publish, call, dial, charge, pay, delete, drop, deploy, or release, among the patterns in `src/classify-openclaw.ts`.
- **Review** (an approval at the default `minTier`): `create`, `update`, `write`, `edit`, `rename`, `modify`, and any tool name the classifier does not recognize.
- **Safe** (never gated): `get_*`, `list_*`, `search_*`, `read_*`, `find_*`, and the other read-style prefixes and suffixes in that file.
- **Bash / shell / exec**: deferred to the `@oked/sdk` shell classifier (`rm -rf`, `git push --force`, and the rest).

`warning` is logged by the SDK classifier and does not block, even if you set `minTier` below `review`.

## What OKed sends

Each approval is one JSON request. These fields are in the body:

| Field | Contents |
|---|---|
| `action` | Tool name, for example `bash` or `deploy_site`. |
| `description` | One-line summary built from the tool arguments. |
| `tier` | `review` or `high_stakes`. |
| `nonce` | A new id for this request, so an old receipt cannot approve a later call. |
| `client` | This package and version, for example `@oked/openclaw@0.6.25`. |
| `metadata.tool_input` | The full tool arguments. |
| `metadata.cwd` | Working directory of the OpenClaw process. |
| `metadata.source` | `openclaw`. |

`metadata.session_id` is included when OpenClaw provides a session id. If there is no session id, the session key is sent under that same field. If neither is present, the field is omitted. The `Authorization` header carries your API key (`Bearer`).

For `bash`, `shell`, and `exec`, `metadata.tool_input` can also include:

- `_file_size_bytes`: size in bytes of an `rm`, `trash`, `trash-put`, or `rmdir` target, when that path exists.
- `_script_body`: the first 4,096 bytes of a local script named by the command, so you can see what will run before you approve. The file is read for `python` (including `python3` and `python3.x`), `node`, `ruby`, `perl`, `deno run`, and `bun run`, when the path ends in `.py`, `.js`, `.mjs`, `.ts`, `.rb`, or `.pl`. A shell script invoked as `bash foo.sh` or `sh foo.sh` stays in the command string only.

The excerpt is redacted before it is sent. On each line, an assignment whose name is or contains the word `key`, `token`, `secret`, or `password` (including `API_KEY`, `apiKey`, and `DB_PASSWORD`) has the value replaced with `[REDACTED]`. AWS access key ids (`AKIA` or `ASIA` plus 16 characters) and `Bearer` tokens are replaced the same way. A PEM private key block is replaced with `[REDACTED]`. This is a best-effort pass. A secret written in an unusual shape can remain in the excerpt, and the command string is sent as the agent wrote it.

The signed receipt is bound to the action, description, tool input (including any excerpt), source, and nonce.

To stop sending the excerpt, set `sendScriptContent` to `false` or export `OKED_SEND_SCRIPT_CONTENT=0`. The default is to send it.

## Degraded-mode behavior

Explicit denials, invalid API keys, a missing API key, receipts that do not verify, and unexpected plugin errors deny the tool call. If OKed cannot be reached, the default is to deny `high_stakes` and allow lower tiers, so a short outage does not stop every workflow. Set `OKED_STRICT_FAIL_CLOSED=1` (or `true`) to deny every sensitive action during an outage. That is the recommended setting when these actions should stay blocked until you can decide.

## Development

From the repo root:

```bash
npm install
npm run build
npm test
```

## License

[Apache-2.0](./LICENSE)
