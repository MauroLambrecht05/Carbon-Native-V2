// .config/dependencies.json — the versions this workspace is built against.
//
// One file, four consumers that must agree: MODULE.bazel pins the Bazel
// modules, .tools/environments/docker/Dockerfile installs the compilers, the
// CI workflow provisions the same, and `carbon doctor` tells a developer
// whether their machine matches.
//
// They did not agree. `flatbuffers` was recorded here as 23.5.26 — a version
// that does not exist on the registry, the earliest being 24.3.7 — while
// MODULE.bazel had been corrected to 24.3.25 to make the workspace resolve at
// all. Nothing compared the two, so the stale value sat in the file that reads
// like the source of truth.

export interface ToolchainVersions {
  /** Compilers and runtimes installed into the environment. */
  readonly toolchains: Readonly<Record<string, string>>;
  /**
   * Bazel modules and generators.
   *
   * Every key here must match a `bazel_dep` version in MODULE.bazel — that is
   * the agreement, and `.tools/validation/check_workspace.py` enforces it.
   */
  readonly libraries: Readonly<Record<string, string>>;
}

/** Names the Dockerfile and CI are expected to provision. */
export type ToolchainName = "llvm" | "rust" | "zig" | "go" | "node" | "dotnet";

export interface VersionMismatch {
  readonly name: string;
  readonly declared: string;
  readonly found: string;
}

/**
 * Extracts a semantic version from a `--version` line.
 *
 * Every tool prints a different shape — `rustc 1.76.0 (07dca489a 2024-02-04)`,
 * `0.12.0`, `go version go1.22.0 windows/amd64` — so this looks for the first
 * dotted number rather than trying to parse each format.
 *
 * Returns null when there is nothing version-shaped, which is different from
 * the tool being absent and is reported differently.
 */
export function extractVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

/**
 * Whether `found` satisfies `declared`.
 *
 * Compares major and minor only. Patch differences are tolerated because the
 * declared version is what CI provisions, not a floor a developer has to match
 * exactly — demanding an exact patch would make `doctor` red on every machine
 * a week after any bump.
 */
export function satisfies(declared: string, found: string): boolean {
  const [dMajor, dMinor] = declared.split(".");
  const [fMajor, fMinor] = found.split(".");
  return dMajor === fMajor && dMinor === fMinor;
}
