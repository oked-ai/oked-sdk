# Security Policy

OKed is a human-in-the-loop authorization layer for AI agents, so we take the integrity of
these packages seriously. The `@oked/*` packages are published with npm provenance (built and
signed on GitHub Actions via OIDC trusted publishing) — verify the provenance panel on each
package's npm page before trusting a build.

## Supported versions

We support the **latest published minor** of each `@oked/*` package. All packages are released
in lockstep and share a version number. Older versions receive fixes only at our discretion.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

- Preferred: open a [private security advisory](https://github.com/oked-ai/oked-sdk/security/advisories/new)
  on this repository.
- Alternatively, email **orendor@gmail.com** with details and reproduction steps.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation as quickly as
the severity warrants. We'll credit reporters who want acknowledgement once a fix is released.
