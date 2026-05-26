// Single source of truth for the installed SDK / CLI bundle version.
// Bump this in lockstep with the package.json versions; the build-release
// script reads it to tag the manifest.
export const SDK_VERSION = "0.1.0";

// Where the updater fetches release metadata from. Override for testing /
// staging releases via the OKED_RELEASE_MANIFEST_URL env var.
export const DEFAULT_MANIFEST_URL =
  "https://github.com/oked-ai/oked-sdk/releases/latest/download/manifest.json";
