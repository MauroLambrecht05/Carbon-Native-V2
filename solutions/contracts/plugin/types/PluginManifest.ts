// carbon-plugin.toml — what a plugin declares about itself.
//
// The TypeScript side of `schema/manifest.fbs`. Both describe the same
// manifest, from opposite ends: the host reads the FlatBuffer form at load
// time, and the toolchain reads the TOML form at build and install time.
//
// They are separate files because they are genuinely different agreements —
// the .fbs is a wire format with frozen field numbering, this is the source
// form a human edits — but they describe one subject, so they live together
// and change together. A field added to one without the other is a plugin the
// toolchain can install and the host cannot load.

/** Languages the plugin SDK ships for. */
export type PluginLanguageId = "rust" | "zig";

export interface PluginManifestData {
  /** Slug: lowercase and hyphenated. Becomes the key in the app's [plugins]. */
  readonly name: string;
  readonly language: PluginLanguageId;
  readonly version?: string;
  readonly description?: string;
  /**
   * Capabilities the plugin requests, as declared in `schema/permissions.fbs`.
   *
   * The host is the enforcement point; the toolchain only carries these
   * through, so an unknown capability is not rejected at install time.
   */
  readonly capabilities?: readonly string[];
}

export const DEFAULT_PLUGIN_LANGUAGE: PluginLanguageId = "rust";

/**
 * The name used when a manifest omits it.
 *
 * Manifests written against the V1 CLI omit both `name` and `language`, and
 * they are in the wild, so absence is a default rather than an error.
 */
export const DEFAULT_PLUGIN_NAME = "plugin";

export function isPluginLanguage(value: string): value is PluginLanguageId {
  return value === "rust" || value === "zig";
}
