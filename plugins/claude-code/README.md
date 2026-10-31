# OKed

OKed asks a person before Claude Code runs a risky action. Safe actions run on their own. You decide in Telegram or on the [web dashboard](https://oked.ai/dashboard). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Install

In a Claude Code session:

```text
/plugin marketplace add oked-ai/oked-sdk
/plugin install oked@oked
```

From a shell, the same two steps are `claude plugin marketplace add oked-ai/oked-sdk` and `claude plugin install oked@oked`. No global npm install is required. The hook is a file in this plugin, run with `node`.

## Pair

Run `/oked:pair`. The script prints a pairing link and, in a terminal, a QR code. Open the link and approve it in Telegram or on the web dashboard. The iPhone app is coming soon. The script then saves the API key into the plugin's API key field when the `claude` command can do that. Otherwise it prints the key once so you can paste it into `/plugin configure oked@oked`. Do not paste the key into the chat.

The API key field is marked sensitive. Claude Code stores it outside `settings.json` and passes it to the hook as `CLAUDE_PLUGIN_OPTION_APIKEY`. Until that field is set, and this machine has no key saved by `oked init`, a risky action returns `ask`, so Claude Code's own permission prompt can decide.

## What is sent

When a risky tool call needs a person, this plugin sends the tool name, the command text or other tool input, the working directory, and a short description of the action to the OKed service at api.oked.ai so a person can approve or deny it. That text is what you see on the approval card in Telegram and on the web dashboard. Safe actions are classified on this machine and are not sent. The API key saved in the plugin configuration is sent only as the credential on that request. A copy of each signed decision receipt stays on this machine in `~/.oked/receipts.jsonl`. If the plugin API key field is empty, the hook uses the key `oked init` already saved for this machine.

## One gate

If you also ran `oked init`, Claude Code has an `oked-hook` command in `.claude/settings.json` or in your user settings. That command and this plugin must not both ask. While the plugin is enabled and its hook file is installed, the settings hook returns allow without calling OKed, and this plugin is the only gate. `oked init` will not add a settings hook when the plugin is already enabled. If you disable the plugin, an existing `oked-hook` entry gates again. `oked uninstall` removes the project entry.

The hook matches `Bash`, `Write`, `Edit`, `Agent`, and MCP tools (`mcp__.*`). Claude Code allows it 690 seconds, which is longer than the approval window, so a timeout is a deny rather than a killed hook.

## License

Apache-2.0. Copyright OKed. Contact [contact@oked.ai](mailto:contact@oked.ai).
