# OKed

OKed asks a person before Claude Code runs a risky action. Safe actions are not sent for approval. You decide in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

This hook never approves a tool call and never changes the tool input. A denial, a timeout, or too many waiting approvals returns `deny`. An unpaired device returns `ask`. A safe action, a warning, and an action a person already approved return no permission decision, so Claude Code's normal permission flow applies.

## Install

In a Claude Code session:

```text
/plugin marketplace add oked-ai/oked-sdk
/plugin install oked@oked
```

From a shell, the same two steps are `claude plugin marketplace add oked-ai/oked-sdk` and `claude plugin install oked@oked`. No global npm install is required. The hook is a file in this plugin, run with `node`. The file `scripts/oked-hook.mjs` is built from `src/main.ts` and the open-source packages in this repo by `scripts/build-claude-plugin.mjs`.

## Pair

Run `/oked:pair`. The script prints a pairing link and, in a terminal, a QR code. Open the link and approve it in Telegram or on the web dashboard. The iPhone app is coming soon. The script then saves the API key into the plugin's API key field when the `claude` command can do that. Otherwise it prints the key once so you can paste it into `/plugin configure oked@oked`. Do not paste the key into the chat.

The API key field is marked sensitive. Claude Code stores it outside `settings.json` and passes it to the hook as `CLAUDE_PLUGIN_OPTION_APIKEY`. This plugin reads the API key only from that field. While it is empty, a risky action returns `ask`, so Claude Code's own permission prompt can decide.

If you paired an older version of this plugin, or you already paired with `oked init`, paste that API key into `/plugin configure oked@oked`. You can also run `/oked:pair` again. The new key is saved in the plugin field.

An optional GitHub token field is marked sensitive too. Claude Code passes it as `CLAUDE_PLUGIN_OPTION_GITHUBTOKEN`. Leave it empty unless you want pull request titles filled in.

## What is sent

When a risky tool call needs a person, this plugin sends the tool name, the command text or other tool input, the working directory, the session id, and a short description of the action to https://api.oked.ai/api/v1/approve so a person can approve or deny it.

That text is what you see on the approval card in Telegram and on the web dashboard.

Safe and warning actions are classified on this machine.

When an API key is present, a safe or warning action fetches saved rules from https://api.oked.ai/api/v1/rules unless `~/.oked/rules-cache.json` has a copy less than five minutes old, and a successful fetch writes that file.

A matching rule sends that action for approval too.

A safe or warning action with no matching rule is not included in an approval request.

When an API key is present, the hook sends this machine's hostname to https://api.oked.ai/api/v1/heartbeat by default, at most once a day, including for an action that stays on this machine, and writes the time to `~/.oked/heartbeat.json` after the send succeeds.

When a receipt names a signing key that is not pinned in this plugin and not already in `~/.oked/receipt-keys.json`, the hook fetches the public keys from https://api.oked.ai/.well-known/oked-receipt-keys.json and writes them to that file.

The API key is the Bearer credential on the approval, rules, and heartbeat requests. The hook reads that key only from the plugin API key field.

Each receipt that verifies is appended to `~/.oked/receipts.jsonl`.

Each deny, each ask, and each degraded pass (the approval service could not be reached, and the action was not high stakes) is appended as one JSON line to `~/.oked/hook.log`, or to the path in OKED_HOOK_LOG when that variable is set, and that file is renamed with a `.1` suffix when it grows past 1 MB. A degraded pass does not approve the tool call. Claude Code's normal permission flow still applies.

When the GitHub token field is set, and an approval card links to a GitHub pull request whose title is not already quoted, the hook requests that title from https://api.github.com. The token is the Bearer credential on that request. When the field is empty, the hook does not contact GitHub and does not use a saved `gh` login.

The pair command sends this machine's hostname, the client type `claude-code`, and the plugin version to https://api.oked.ai/api/v1/device/code, polls https://api.oked.ai/api/v1/device/poll until you approve, and asks the `claude` command to store the API key in the plugin configuration.

## One gate

If you also ran `oked init`, Claude Code has an `oked-hook` command in `.claude/settings.json` or in your user settings. That command and this plugin must not both ask. While the plugin is enabled and its hook file is installed, the settings hook returns allow without calling OKed, and this plugin is the only gate. When that settings hook is the one that will run, this plugin returns no permission decision, so it does not approve the call. `oked init` will not add a settings hook when the plugin is already enabled. If you disable the plugin, an existing `oked-hook` entry gates again. `oked uninstall` removes the project entry.

The hook matches `Bash`, `PowerShell`, `Write`, `Edit`, `Agent`, `Task`, and MCP tools (`mcp__.*`). On Windows without Git Bash, Claude Code sends shell commands to `PowerShell` and does not register `Bash`. `Task` is the older name of the subagent tool. Current Claude Code sends `Agent`. Claude Code allows the hook 690 seconds, which is longer than the approval window, so a timeout is a deny rather than a killed hook.

## Privacy

This plugin follows the [OKed privacy policy](https://oked.ai/privacy). Deletion requests go to [contact@oked.ai](mailto:contact@oked.ai).

## License

Apache-2.0. Copyright OKed. Contact [contact@oked.ai](mailto:contact@oked.ai).
