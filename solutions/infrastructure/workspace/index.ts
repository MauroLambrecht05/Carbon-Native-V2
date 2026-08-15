// @carbon/workspace — where things live in a carbon workspace, and reading
// the manifest that declares a project.
//
//   ports/      ManifestRepository — where a manifest comes from
//   adapters/   the two things that touch the disk: WorkspaceLayout, which
//               finds every path by searching upward for MODULE.bazel, and
//               the TOML manifest reader
//
// WorkspaceLayout sat loose at the package root, which read as "this is the
// package" rather than "this is one adapter of two". It has no port because
// nothing would implement a second one — but it walks the filesystem, so it
// belongs on the same side of the line as the TOML reader.

export * from "./adapters/WorkspaceLayout.ts";
export type { ManifestRepository } from "./ports/ManifestRepository.ts";
export { TomlManifestRepository, manifestPath, hasManifest, loadCarbonConfig, loadConfig } from "./adapters/TomlManifestRepository.ts";
