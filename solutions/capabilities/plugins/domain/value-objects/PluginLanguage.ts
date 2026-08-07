// The languages a native plugin can be written in.
//
// Each language answers the same four questions — what file marks a project,
// what command builds it, how a release build is requested, and where the
// artifact lands. Keeping those together is what lets the use cases treat Rust
// and Zig identically instead of branching on language five separate times,
// which is what the CLI command did.

export type LanguageId = "rust" | "zig";

export interface PluginLanguage {
  readonly id: LanguageId;
  /** Presence of this file in a directory identifies the language. */
  readonly marker: string;
  readonly buildCommand: string;
  /** Extra arguments that turn a debug build into an optimised one. */
  readonly releaseArgs: readonly string[];
  readonly debugArgs: readonly string[];
  /** Directories to search for the built library, most-preferred first. */
  readonly artifactDirs: readonly string[][];
}

export const RUST: PluginLanguage = {
  id: "rust",
  marker: "Cargo.toml",
  buildCommand: "cargo",
  releaseArgs: ["build", "--release"],
  debugArgs: ["build"],
  // Release first: after `cargo build --release` both may exist, and the
  // release artifact is the one worth installing.
  artifactDirs: [
    ["target", "release"],
    ["target", "debug"],
  ],
};

export const ZIG: PluginLanguage = {
  id: "zig",
  marker: "build.zig",
  buildCommand: "zig",
  releaseArgs: ["build", "-Doptimize=ReleaseFast"],
  debugArgs: ["build"],
  artifactDirs: [
    ["zig-out", "lib"],
    ["zig-out", "bin"],
  ],
};

export const LANGUAGES: readonly PluginLanguage[] = [RUST, ZIG];

/** Accepts the `rs` alias the CLI has always taken for `rust`. */
export function languageNamed(id: string): PluginLanguage | undefined {
  if (id === "rs") return RUST;
  return LANGUAGES.find((l) => l.id === id);
}
