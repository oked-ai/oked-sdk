# Releasing

All `@oked/*` packages are versioned in lockstep. They share one version number and are published together. There are fifteen: `sdk`, `hook-core`, `claude-code`, `codex`, `cursor`, `copilot`, `claude-agent-sdk`, `ai-sdk`, `openai-agents`, `openclaw`, `openclaw-cli`, `receipt-core`, `verify`, `scan`, and `langgraph`.

Releases are cut by hand with a git tag. Pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`, which publishes every package with npm's OIDC trusted publishing (the workflow has `id-token: write` and stores no npm token).

The repository is public. The workflow runs `npm publish` and does not pass `--provenance`. npm still signs a provenance statement for these publishes: the `v0.6.20` run logged "Signed provenance statement" for every package, and `npm view <pkg>@0.6.20 dist.attestations.provenance` returns a SLSA attestation. Check the provenance panel on each package's npm page. An older copy of this file said the repo was private and that provenance was off. That does not match the repository or the packages currently on npm.

## One-time setup (already done, kept for reference)

- An npm account with 2FA and a free `oked` organization (the `@oked` scope).
- A Trusted Publisher on npmjs for each package. Every field must match the workflow:
  - Organization or user: `oked-ai`
  - Repository: `oked-sdk`, this monorepo, not the package name. All of them use `oked-sdk`. A wrong repo here shows up as a misleading `ENEEDAUTH` at publish (npm/cli#9088), not a clear mismatch error.
  - Workflow filename: `publish.yml`. Environment name: blank.
  - Allowed actions: tick "Allow npm publish". `npm stage publish` is always on, and "Allow npm dist-tag" stays off. The box on the settings page must list both `npm publish` and `npm stage publish`. A publisher with only `npm stage publish` fails the publish with `403 OIDC permission denied for this action`, after the provenance is signed. New publishers default to stage only, so tick the box every time.

### Adding a new package

npm only lets you attach a Trusted Publisher to a package that already exists, so the first version of a new package is published by hand from a maintainer's machine, before the tag that would publish it:

```bash
npm run build
cd packages/<name> && npm publish --access public
```

Then add the Trusted Publisher on npmjs (same fields as above) and list the package in the `publish.yml` matrix. From the next tag on, CI publishes it with the others. A tag pushed before the manual publish fails that package's job (`ENEEDAUTH`) while the rest publish.

`@oked/scan` is in the matrix and is not on npm yet. The first `npm publish` for it is the manual step above. A tag pushed before that publish fails the `scan` job only.

### On npm

Every package that has already been published is on npm and has a Trusted Publisher: organization `oked-ai`, repository `oked-sdk`, workflow `publish.yml`. `hook-core`, `codex`, `cursor`, `copilot`, `langgraph`, `ai-sdk`, and `openai-agents` were first published by hand at 0.6.21. In v0.6.22, `hook-core`, `codex`, `cursor`, and `copilot` failed with the 403 above, because their publishers had only `npm stage publish`. They were fixed for v0.6.23. Confirm each new package has a Trusted Publisher with both permissions (same fields as above) before tagging. A tag pushed before that publisher exists fails that package's job (`ENEEDAUTH`) while the rest publish. A `vX.Y.Z` tag publishes every package in the matrix that already exists on npm. Do not publish from a pull request.

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
   `scripts/bump-version.mjs` rewrites `version` in every `packages/*/package.json`, rewrites every internal `@oked/*` dependency pin to that exact version, sets the same version in `plugins/claude-code/.claude-plugin/plugin.json`, and rebuilds `plugins/claude-code/scripts/oked-hook.mjs`. All internal pins are exact (not caret) on purpose, so each package runs against the SDK it was tested with. There is no by-hand pin step. Commit the plugin manifest and the bundle with the version bump. CI rejects a bundle that does not match a fresh build, and the publish workflow rejects a tag whose plugin version or bundle does not match the packages.
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
6. Watch the `Publish` workflow. When it is green, every package in the matrix that already exists on npm shows the new version. A package that has not had its first manual publish yet fails that job only (`ENEEDAUTH`); the others still publish.

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
npm view @oked/sdk version          # should equal X.Y.Z (repeat for each other package already on npm)
npx -y @oked/claude-code@X.Y.Z --help
```

## ClawHub (`@oked/openclaw`)

`openclaw plugins install @oked/openclaw` installs from ClawHub, OpenClaw's plugin registry. An npm publish does not put the package there. `.github/workflows/publish.yml` publishes `@oked/openclaw` to ClawHub after that package's npm publish, on the same `vX.Y.Z` tag and on `workflow_dispatch`. The step runs only for the `openclaw` matrix entry. It uses the `CLAWHUB_TOKEN` repository secret. If that secret is missing or blank, the step logs `CLAWHUB_TOKEN is not set. Skipping ClawHub publish for @oked/openclaw.` and exits 0, so the npm publish is not failed. Do not publish from a pull request.

The workflow installs `clawhub@0.24.1`. The upload is accepted before ClawHub's security checks finish. The package stays out of `openclaw plugins install` until those checks pass. A rejected upload fails the openclaw job after npm has already published that package. The other packages in the matrix are separate jobs.

### One-time setup

ClawHub can only attach a trusted publisher to a package that already exists, the same constraint npm has. Do these steps once, from a maintainer machine, before relying on the workflow. The publisher handle must be `oked` so it matches the `@oked` scope.

```bash
npm install -g clawhub@0.24.1
clawhub login
clawhub whoami
clawhub publisher create oked --display-name "OKed"
npm run build
clawhub package validate packages/openclaw
clawhub package publish packages/openclaw --family code-plugin --owner oked
clawhub package trusted-publisher set @oked/openclaw \
  --repository oked-ai/oked-sdk \
  --workflow-filename publish.yml
```

`clawhub login` is device login. Approve it in the browser. If `clawhub whoami` already prints the handle `oked`, skip `publisher create`. Otherwise `clawhub publisher create` claims the `oked` handle. If that handle is already taken, do not publish under a different owner. The package scope would not match. Open an Org / Namespace Claim with public proof, and keep tokens out of the issue. Questions: [contact@oked.ai](mailto:contact@oked.ai).

Create an API token in ClawHub (Settings, API tokens). Add it as the Actions secret `CLAWHUB_TOKEN` on `oked-ai/oked-sdk`. `clawhub token` prints the token stored by `clawhub login` if you want to reuse that one. Do not commit it, and do not paste it into a pull request.

Tag-push publishes still need `CLAWHUB_TOKEN`. Trusted publisher config is what a later secretless `workflow_dispatch` can use. This workflow sends the token whenever the secret is present, including the first publishes and any break-glass run.

A tag pushed before this setup still publishes to npm. The ClawHub step skips until the secret exists.

## Python packages on PyPI

`oked` and `oked-langgraph` live under `python/`. They are not npm packages, and `npm run bump` does not change them. Their version strings are in `python/*/pyproject.toml` and in each package's `__version__`. Keep those aligned with the `@oked/*` version when you want one release number across languages. A `vX.Y.Z` tag publishes npm only. A `py-vX.Y.Z` tag publishes PyPI, and only after the one-time steps below.

The PyPI names `oked` and `oked-langgraph` were unclaimed when this was added. Do not publish from a pull request.

### First publish (once per package, by hand)

PyPI trusted publishing can only be attached to a project that already exists, the same constraint npm has. Publish `oked` first, then `oked-langgraph`, because the LangGraph package depends on that exact `oked` version.

```bash
python -m pip install build twine
python -m build python/oked
python -m twine upload python/oked/dist/*
python -m build python/oked-langgraph
python -m twine upload python/oked-langgraph/dist/*
```

Use a PyPI account that can create these projects. Then, on pypi.org, open each project, go to Publishing, and add a trusted publisher:

- Owner: `oked-ai`
- Repository name: `oked-sdk`
- Workflow name: `publish-python.yml`
- Environment name: leave blank

Do that for both `oked` and `oked-langgraph`.

### Later Python releases

1. Set `version` in both `python/*/pyproject.toml` files, `__version__` in `python/oked/src/oked/__init__.py` and `python/oked-langgraph/src/oked_langgraph/gate.py`, and the `oked==` pin in `python/oked-langgraph/pyproject.toml`, all to the same `X.Y.Z`.
2. Tag and push. The tag must match that version:

```bash
git tag py-vX.Y.Z
git push origin py-vX.Y.Z
```

`.github/workflows/publish-python.yml` checks the tag against both packages, builds them, and publishes with PyPI's OIDC trusted publishing. The workflow stores no PyPI token. A tag pushed before the manual first publish fails that package (`invalid-publisher` or a trusted-publisher error) until the project exists and the publisher above is saved.

## Bootstrap (first ever publish only)

The first `0.1.0` was published by hand, from a maintainer's machine, to create the packages on npm. OIDC trusted publishing can only be attached to packages that already exist. See `packages/*/package.json` and the npm org for the publishers. Later releases use the tag-triggered workflow above.
