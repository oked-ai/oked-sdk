---
description: Pair this Claude Code install with OKed and save the API key. Use when the user wants to pair, connect OKed, or set the OKed API key.
---

Pair this machine with OKed so risky Claude Code actions can wait for a person.

Decisions are made in Telegram or on the web dashboard at https://oked.ai/dashboard. The iPhone app is coming soon. Questions go to contact@oked.ai.

Do this:

1. Run the pairing script from the plugin directory. Pass `--no-browser` when there is no display:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oked-hook.mjs" pair --no-browser
```

2. Show the user the pairing link the script prints. They open it and approve in Telegram or on the web dashboard. The iPhone app is coming soon. A terminal also prints a QR code of that link. The phone camera opens the link in the browser.

3. If the script says the API key was saved to the plugin configuration, tell the user to start a new Claude Code session. Do not ask them to paste the key.

4. If the script prints an API key because it could not store it, tell the user to copy that key into the OKed plugin API key field. They can open it with `/plugin configure oked@oked`. Do not repeat the full key in your reply.

5. Until a key is saved, risky actions return `ask`, so Claude Code's own prompt can decide. That is the safe unpaired behavior.

If `oked init` already installed an `oked-hook` settings entry, that entry stands down while this plugin's hook file is on disk, and this plugin gates. One action is asked once. `oked uninstall` removes the project settings entry.
