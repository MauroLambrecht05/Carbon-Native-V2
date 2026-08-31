// carbon/manifest.toml's shape — the real source of truth for which plugins
// compose an app.
//
//   schema = 1
//
//   [plugins.carbon-pulse]
//   source = "local"
//   enabled = true
//
//   [plugins.fonts]
//   source = "vendor"
//   version = "0.1.4"
//   enabled = true
//
// `source` says which of carbon/plugins/local/<name>/ or
// carbon/plugins/vendor/<name>/ owns this plugin's source/artifact-origin.
// `enabled = false` is the one surviving disable toggle — skipped by both
// carbon/build.zig (nothing built/staged) and the Rust loader (nothing
// loaded), directory and entry both left untouched.
//
// ── WHY THIS FILE HOLDS ONLY TYPES ───────────────────────────────────────────
// Reading and writing this shape needs a real TOML library for a full parse
// -> mutate -> stringify round trip (see infrastructure/AppManifestCodec.ts's
// own header comment for why that's safe here — this file is tool-owned, so
// there's no human formatting to preserve). Domain may not depend on a
// concrete library, so the codec lives in infrastructure/ instead; this file
// is the vocabulary both application and infrastructure agree on.

export type PluginSource = "local" | "vendor";

export interface AppManifestEntry {
  readonly source: PluginSource;
  readonly enabled: boolean;
  /** Vendor only. Informational — nothing resolves against it today. */
  readonly version?: string;
}

export interface AppManifest {
  readonly schema: number;
  readonly plugins: ReadonlyMap<string, AppManifestEntry>;
}

export const CURRENT_MANIFEST_SCHEMA = 1;
