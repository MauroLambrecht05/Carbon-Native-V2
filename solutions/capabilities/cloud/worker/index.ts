// @carbon/worker — the worker side of Carbon Cloud.
//
//   application/ports/    what a worker needs: a control plane, a repo
//                         checkout, the local build pipeline, an uploader
//   application/usecases/ RunNextJobUseCase — one claim-run-report cycle
//   infrastructure/       HTTP control-plane client, git checkout, the real
//                         pipeline (composes bundling + packaging + signing),
//                         S3 upload
//
// What this does NOT know: what a build IS or how it's tracked — that's
// @carbon/orchestration, which this claims work from and reports back
// to.

export { RunNextJobUseCase, type JobOutcome } from "./application/usecases/RunNextJobUseCase.ts";
export type { ControlPlaneClient } from "./application/ports/ControlPlaneClient.ts";
export type { RepoFetcher } from "./application/ports/RepoFetcher.ts";
export type { LocalPipeline, PackagedTarget } from "./application/ports/LocalPipeline.ts";
export type { ArtifactUploader, UploadedArtifact } from "./application/ports/ArtifactUploader.ts";
export { HttpControlPlaneClient, ControlPlaneRequestError } from "./infrastructure/HttpControlPlaneClient.ts";
export { GitRepoFetcher, GitCloneError, GitCheckoutError } from "./infrastructure/GitRepoFetcher.ts";
export { RealLocalPipeline, type SigningKey } from "./infrastructure/RealLocalPipeline.ts";
export { S3ArtifactUploader, UploadFailedError } from "./infrastructure/S3ArtifactUploader.ts";

// Builds on worker leases (the platform worker protocol, /worker/v1).
export { RunLeasedBuildUseCase, digestDependencyLocks, redactor, type LeasedBuildOptions, type LeasedBuildOutcome } from "./application/usecases/RunLeasedBuildUseCase.ts";
export {
  BuildFailure, LeaseLostError, type BuildPipeline, type BuildProtocol, type BuildResult, type BuildRun, type BuildWorkspace, type HeldBuildLease, type SourceCheckout, type ToolVersion, type WorkspaceProvider,
} from "./application/ports/LeasedBuild.ts";
export { HttpBuildProtocol, WorkerProtocolError } from "./infrastructure/HttpBuildProtocol.ts";
export { GitSourceCheckout } from "./infrastructure/GitSourceCheckout.ts";
export { DisposableWorkspaces, WorkspaceNotErasedError } from "./infrastructure/DisposableWorkspaces.ts";
export { CarbonBuildPipeline, WINDOWS_CERTIFICATE_PASSWORD_SECRET, WINDOWS_CERTIFICATE_SECRET } from "./infrastructure/CarbonBuildPipeline.ts";

// Functions on worker leases.
export { RunLeasedFunctionUseCase, type FunctionProtocol, type FunctionRun, type FunctionRunResult, type FunctionRunner, type LeasedFunctionOutcome } from "./application/usecases/RunLeasedFunctionUseCase.ts";
export { BunFunctionRunner } from "./infrastructure/BunFunctionRunner.ts";
