// @carbon/publishing — announcing a release and getting its artifacts to
// where users fetch them.
//
//   application/     building the manifest a release announces
//   infrastructure/  one S3-compatible store
//
// The artifact store has no port yet: there is exactly one implementation and
// no second candidate to shape an interface against, and a port derived from a
// single implementation is just that implementation with extra steps.

export {
  BuildUpdateManifestUseCase,
  type BuildUpdateManifestRequest,
} from "./application/usecases/BuildUpdateManifestUseCase.ts";
export * from "./infrastructure/S3ArtifactStore.ts";
