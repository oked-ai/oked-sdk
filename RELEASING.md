# Releasing

All `@oked/*` packages are versioned **in lockstep** — they always share the same version
number and are published together. We use **manual git tags**; pushing a `vX.Y.Z` tag triggers
`.github/workflows/publish.yml`, which publishes every package via OIDC trusted publishing (no
stored token). Packages are published **without** npm provenance because the repo is private.

## One-time setup (already done — keep for reference)

- An npm account with 2FA and a free `oked` organization (backs the `@oked` scope).
- The repo is **private**, so `npm publish` must not pass `--provenance`: npm (sigstore) refuses
  provenance from private source repos (`422 ... Unsupported GitHub Actions source repository
  visibility: "private"`). If the repo is made public again, `--provenance` can be restored.
- A **Trusted Publisher** configured on npmjs for **each** package. Every field must
  match the workflow exactly:
  - Organization or user: `oked-ai`
  - **Repository: `oked-sdk`** — the monorepo, NOT the package name. All of them use `oked-sdk`.
    A wrong repo here surfaces as a misleading `ENEEDAUTH` at publish (npm/cli#9088), not a
    clear mismatch error.
  - Workflow filename: `publish.yml`; Environment name: blank; Allowed action: `npm publish`.

### Adding a new package

npm only lets you attach a Trusted Publisher to a package that already exists, so the
**first** version of a new package (for example `@oked/receipt-core`, `@oked/verify`) is
published by hand from a maintainer's machine, before the tag that would publish it:

```bash
npm run build
cd packages/<name> && npm publish --access public
```

Then add the Trusted Publisher on npmjs (same fields as above) and list the package in the
`publish.yml` matrix. From the next tag on, CI publishes it like the others. A tag pushed
before the manual publish fails that package's job (`ENEEDAUTH`) while the rest publish.

### Why the workflow publishes one package per job

`npm publish --workspaces` does NOT engage npm's OIDC code path (fails `ENEEDAUTH`), so
`publish.yml` uses a `matrix` with one package per job and runs a plain single-package
`npm publish` from each package dir. `dist` is built first, so `--ignore-scripts` skips the
redundant `prepublishOnly` rebuild (whose `prebuild` needs the repo root). Requires npm
>= 11.5.1 (the workflow upgrades npm; Node 22 ships 10.x).

## Cutting a release

1. Make sure `main` is green (the `ci.yml` gate passed).
2. Bump every package to the new version in lockstep:
   ```bash
   npm run bump -- <patch|minor|major>   # e.g. npm run bump -- patch
   # or an explicit version, including a prerelease:
   npm run bump -- 0.2.0-beta.1
   ```
   `scripts/bump-version.mjs` rewrites `version` in every `packages/*/package.json` **and**
   rewrites every internal `@oked/*` dependency pin to that exact version. All internal pins
   are exact (not caret) on purpose, so each package always runs against the SDK it was tested
   with. There is no longer a by-hand pin step.
3. Refresh the lockfile so `package-lock.json` records the new versions:
   ```bash
   npm install
   ```
4. Commit the version bumps:
   ```bash
   git commit -am "Release vX.Y.Z"
   ```
5. Tag and push. **The tag must match the version** (`vX.Y.Z` for version `X.Y.Z`); the
   workflow fails the publish if they differ:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
6. Watch the `Publish` workflow. When green, all 5 packages show the new version on npm.

### Release channels (dist-tags)

The workflow picks the npm dist-tag from the version string:

- **Stable** `X.Y.Z` -> `latest` (what `npm install @oked/...` resolves to).
- **Prerelease** `X.Y.Z-beta.N` -> `next` (opt-in via `npm install @oked/sdk@next`); a
  prerelease never becomes `latest`.

Promote a prerelease to stable by cutting the matching stable version (re-run `npm run bump`),
or move the dist-tag pointer without republishing:

```bash
npm dist-tag add @oked/sdk@0.2.0 latest   # repeat per package
```

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
