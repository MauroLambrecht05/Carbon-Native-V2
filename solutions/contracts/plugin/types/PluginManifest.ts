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

/**
 * The language the plugin SDK ships for.
 *
 * One member, and a union rather than a literal so the toolchain keeps a name
 * for the concept. Rust was the other one; see
 * capabilities/plugins/domain/value-objects/PluginLanguage.ts for why it is
 * not any more.
 */
export type PluginLanguageId = "zig";

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

  /**
   * Extension points the plugin implements, by id — see
   * `registry/extension-points.zig`, and `EXTENSION_POINTS` in
   * ./ExtensionPoints.ts for the generated list.
   *
   * Advisory. What a plugin actually implements is which symbols it exports,
   * and that is what the loader binds. This list exists so the toolchain can
   * say "you declared `paint.before` but did not export
   * `carbon_plugin_before_paint`" at install time, and so `carbon plugin list`
   * can show what a plugin does without loading it.
   */
  readonly extensionPoints?: readonly string[];
}

export const DEFAULT_PLUGIN_LANGUAGE: PluginLanguageId = "zig";

/**
 * The name used when a manifest omits it.
 *
 * Manifests written against the V1 CLI omit both `name` and `language`, and
 * they are in the wild, so absence is a default rather than an error.
 */
export const DEFAULT_PLUGIN_NAME = "plugin";

export function isPluginLanguage(value: string): value is PluginLanguageId {
  return value === "zig";
}
