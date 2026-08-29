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
export {
  PublishReleaseUseCase,
  type PublishReleaseRequest,
  type PublishReleaseResult,
} from "./application/usecases/PublishReleaseUseCase.ts";
export {
  RollbackReleaseUseCase,
  type RollbackReleaseRequest,
  type RollbackReleaseResult,
} from "./application/usecases/RollbackReleaseUseCase.ts";
export {
  YankReleaseUseCase,
  type YankReleaseRequest,
  type YankReleaseResult,
} from "./application/usecases/YankReleaseUseCase.ts";
export * from "./infrastructure/S3ArtifactStore.ts";
