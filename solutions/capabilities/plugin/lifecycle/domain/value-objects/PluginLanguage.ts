// The language a native plugin is written in.
//
// ── THERE IS ONE ────────────────────────────────────────────────────────────
// Zig. This was a two-element list — Rust and Zig — with an SDK, a template,
// an artifact-layout rule and a `--lang` flag for each, and the toolchain
// branched on the answer in five places.
//
// Zig is the one, for reasons that are properties of the job rather than
// taste:
//
//   * A plugin is a C-ABI shared library. Zig's `export fn ... callconv(.c)`
//     IS that, with no attribute soup and no `#[no_mangle]` unsafe block.
//   * `@cImport` reads `carbon_plugin.h` directly, so the SDK does not
//     hand-mirror the ABI — the Rust SDK had a whole `ffi.rs` doing exactly
//     that, and a hand-mirrored ABI is a second source of truth.
//   * The extension-point registry IS Zig. A plugin `@import`s
//     `extension-points.zig` and gets the ids and signatures comptime-checked
//     against the same file the runtime's table was generated from. No other
//     language gets that without a generated binding.
//   * `zig build` cross-compiles to every target carbon ships without a
//     toolchain per host.
//
// The type stays a record rather than collapsing into constants, because the
// four questions below are the ones the use cases ask, and answering them
// through one value is what let `BuildPluginUseCase` and `InstallPluginUseCase`
// stop branching on language at all.

export type LanguageId = "zig";

export interface PluginLanguage {
  readonly id: LanguageId;
  /** Presence of this file in a directory identifies a plugin project. */
  readonly marker: string;
  readonly buildCommand: string;
  /** Extra arguments that turn a debug build into an optimised one. */
  readonly releaseArgs: readonly string[];
  readonly debugArgs: readonly string[];
  /** Directories to search for the built library, most-preferred first. */
  readonly artifactDirs: readonly string[][];
}

export const ZIG: PluginLanguage = {
  id: "zig",
  marker: "build.zig",
  buildCommand: "zig",
  // NOT -Doptimize=ReleaseFast. Every plugin's build.zig calls
  // standardOptimizeOption WITH .preferred_optimize_mode set (see
  // products/carbon-ext/presentation/templates/plugin/build.zig.tmpl) — and
  // passing that argument is what turns the option from the usual 4-way
  // -Doptimize=<Mode> enum into a boolean -Drelease=[bool] toggle instead.
  // Confirmed against a real `zig build --help` in the plugin directory:
  // -Doptimize errors "invalid option", -Drelease=true is what's offered and
  // what actually builds.
  releaseArgs: ["build", "-Drelease=true"],
  debugArgs: ["build"],
  artifactDirs: [
    ["zig-out", "lib"],
    ["zig-out", "bin"],
  ],
};

export const LANGUAGES: readonly PluginLanguage[] = [ZIG];

/** The language every plugin is written in. */
export const DEFAULT_LANGUAGE = ZIG;

/**
 * Resolve a language name.
 *
 * Still a lookup rather than a constant so the error path stays: a
 * `carbon-plugin.toml` in the wild says `language = "rust"`, and the caller
 * turning `undefined` into "this workspace builds Zig plugins" is a better
 * message than a silent default that then fails at `cargo: not found`.
 */
export function languageNamed(id: string): PluginLanguage | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
