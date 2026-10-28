# Releasing

All `@oked/*` packages are versioned in lockstep. They share one version number and are published together. There are seven: `sdk`, `claude-code`, `claude-agent-sdk`, `openclaw`, `openclaw-cli`, `receipt-core`, and `verify`.

Releases are cut by hand with a git tag. Pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`, which publishes every package with npm's OIDC trusted publishing (the workflow has `id-token: write` and stores no npm token).

The repository is public. The workflow runs `npm publish` and does not pass `--provenance`. npm still signs a provenance statement for these publishes: the `v0.6.20` run logged "Signed provenance statement" for every package, and `npm view <pkg>@0.6.20 dist.attestations.provenance` returns a SLSA attestation. Check the provenance panel on each package's npm page. An older copy of this file said the repo was private and that provenance was off. That does not match the repository or the packages currently on npm.

## One-time setup (already done, kept for reference)

- An npm account with 2FA and a free `oked` organization (the `@oked` scope).
- A Trusted Publisher on npmjs for each package. Every field must match the workflow:
  - Organization or user: `oked-ai`
  - Repository: `oked-sdk`, this monorepo, not the package name. All of them use `oked-sdk`. A wrong repo here shows up as a misleading `ENEEDAUTH` at publish (npm/cli#9088), not a clear mismatch error.
  - Workflow filename: `publish.yml`. Environment name: blank. Allowed action: `npm publish`.

### Adding a new package

npm only lets you attach a Trusted Publisher to a package that already exists, so the first version of a new package is published by hand from a maintainer's machine, before the tag that would publish it:

```bash
npm run build
cd packages/<name> && npm publish --access public
```

Then add the Trusted Publisher on npmjs (same fields as above) and list the package in the `publish.yml` matrix. From the next tag on, CI publishes it with the others. A tag pushed before the manual publish fails that package's job (`ENEEDAUTH`) while the rest publish.

### Why the workflow publishes one package per job

`npm publish --workspaces` does not engage npm's OIDC code path (it fails with `ENEEDAUTH`), so `publish.yml` uses a matrix with one package per job and runs a single-package `npm publish` from each package directory. `dist` is built first, so `--ignore-scripts` skips the redundant `prepublishOnly` rebuild (whose `prebuild` needs the repo root). The workflow upgrades npm before publishing. Its comment requires npm >= 11.5.1 (Node 22 ships npm 10.x).

## Cutting a release

1. Make sure `main` is green (the `ci.yml` gate passed).
2. Bump every package to the new version in lockstep:
   ```bash
   npm run bump -- <patch|minor|major>   # e.g. npm run bump -- patch
   # or an explicit version, including a prerelease:
   npm run bump -- 0.2.0-beta.1
   ```
   `scripts/bump-version.mjs` rewrites `version` in every `packages/*/package.json` and rewrites every internal `@oked/*` dependency pin to that exact version. All internal pins are exact (not caret) on purpose, so each package runs against the SDK it was tested with. There is no by-hand pin step.
3. Refresh the lockfile so `package-lock.json` records the new versions:
   ```bash
   npm install
   ```
4. Commit the version bumps:
   ```bash
   git commit -am "Release vX.Y.Z"
   ```
5. Tag and push. The tag must match the version (`vX.Y.Z` for version `X.Y.Z`). The workflow fails the publish if they differ:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
6. Watch the `Publish` workflow. When it is green, all seven packages show the new version on npm.

### Release channels (dist-tags)

The workflow picks the npm dist-tag from the version string:

- Stable `X.Y.Z` goes to `latest` (what `npm install @oked/...` resolves to).
- Prerelease `X.Y.Z-beta.N` goes to `next` (opt in with `npm install @oked/sdk@next`). A prerelease never becomes `latest`.

Promote a prerelease to stable by cutting the matching stable version (re-run `npm run bump`), or move the dist-tag pointer without republishing:

```bash
npm dist-tag add @oked/sdk@0.2.0 latest   # repeat per package
```

## Verifying a release

```bash
npm view @oked/sdk version          # should equal X.Y.Z (repeat for the other six)
npx -y @oked/claude-code@X.Y.Z --help
```

## Bootstrap (first ever publish only)

The first `0.1.0` was published by hand, from a maintainer's machine, to create the packages on npm. OIDC trusted publishing can only be attached to packages that already exist. See `packages/*/package.json` and the npm org for the publishers. Later releases use the tag-triggered workflow above.
