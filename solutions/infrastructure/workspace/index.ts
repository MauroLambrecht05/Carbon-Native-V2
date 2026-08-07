// @carbon/workspace — where things live in a carbon workspace, and reading
// the manifest that declares a project.
//
//   WorkspaceLayout   every path, found by searching for MODULE.bazel
//   ports/            ManifestRepository — where a manifest comes from
//   adapters/         the TOML reader

export * from "./WorkspaceLayout.ts";
export type { ManifestRepository } from "./ports/ManifestRepository.ts";
export { TomlManifestRepository, manifestPath, hasManifest, loadCarbonConfig, loadConfig } from "./adapters/TomlManifestRepository.ts";
