# Changelog

All `@oked/*` packages share one version. This file notes behavior changes that are not yet in a tagged release, then the notes for each tag.

Decisions are made in Telegram and on the [web dashboard](https://oked.ai/dashboard?ref=github-oked-sdk). The iPhone app is coming soon. Questions: [contact@oked.ai](mailto:contact@oked.ai).

## Unreleased

### @oked/hook-core

- New package. `decide()` classifies a tool call, waits for a person, checks the signed receipt, and fails closed. `HOOK_TIMEOUT_SECONDS` is 690, which is 60 seconds above the SDK wait of 630.
- `@oked/claude-code` calls that gate. Claude's stdin and stdout, the unpaired `ask`, and `oked init` are unchanged.

### @oked/codex

- New package. `npx oked-codex init` writes a `PreToolUse` hook to `.codex/hooks.json` with timeout 690 and matcher `*`.
- An allow prints nothing, because Codex treats an explicit allow as unsupported. An unpaired device is denied with `Pair first: run oked-codex init`. A hook timeout or a crash still fails open inside Codex. Trust the hook with `/hooks`.

## 0.6.21

Tagged release of the packages that were already on npm. See the git history for the classifier and receipt fixes in that tag.
