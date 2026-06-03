# Releasing

All `@oked/*` packages are versioned **in lockstep** — they always share the same version
number and are published together. We use **manual git tags**; pushing a `vX.Y.Z` tag triggers
`.github/workflows/publish.yml`, which publishes every package with npm provenance via OIDC
trusted publishing (no stored token).

## One-time setup (already done once the org exists)

- An npm account with 2FA and a free `oked` organization (backs the `@oked` scope).
- A **Trusted Publisher** configured on npmjs for **each** of the 5 packages, pointing at the
  `oked-ai/oked-sdk` repo and the `publish.yml` workflow.

## Cutting a release

1. Make sure `main` is green (the `ci.yml` gate passed).
2. Bump every package to the new version in lockstep:
   ```bash
   npm run version:all -- <patch|minor|major>   # e.g. npm run version:all -- patch
   ```
   This rewrites `version` in all 5 `packages/*/package.json`.
3. **Bump the pinned dependency by hand.** `@oked/claude-code` pins `@oked/sdk` at an **exact**
   version (not a caret range) on purpose, so the hook always runs against the SDK it was
   tested with. `npm version` does **not** rewrite that pin — update
   `packages/claude-code/package.json` `dependencies["@oked/sdk"]` to the new version manually.
4. Commit the version bumps:
   ```bash
   git commit -am "Release vX.Y.Z"
   ```
5. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
6. Watch the `Publish` workflow. When green, each package page on npmjs shows the
   green provenance panel ("Built and signed on GitHub Actions").

## Verifying a release

```bash
npm view @oked/sdk version          # should equal X.Y.Z (repeat for the other four)
npx -y @oked/claude-code@X.Y.Z --help
```

## Bootstrap (first ever publish only)

The very first `0.1.0` was published **manually and locally** to create the packages on npm,
because OIDC trusted publishing can only be attached to packages that already exist. See
`packages/*/package.json` and the npm org for the publishers. Subsequent releases use the
tag-triggered workflow described above.
