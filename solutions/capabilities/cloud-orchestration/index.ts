// @carbon/cloud-orchestration — a repo + commit, turned into a tracked build.
//
//   domain/               Build, its status state machine
//   application/ports/    BuildRepository — where builds are stored
//   application/usecases/ create, claim, report progress/outcome, fetch
//   infrastructure/       InMemoryBuildRepository (tests),
//                         PostgresBuildRepository (real)
//
// What this does NOT know: how a build actually gets executed. That's
// cloud-workers, which claims through this capability's use cases and calls
// back into @carbon/bundling, @carbon/packaging and @carbon/signing itself.

export { Build, InvalidTransitionError, type BuildArtifact, type BuildProps } from "./domain/entities/Build.ts";
export { canTransition, type BuildStatus } from "./domain/value-objects/BuildStatus.ts";
export { BuildNotFoundError } from "./domain/errors/BuildNotFoundError.ts";
export type { BuildRepository } from "./application/ports/BuildRepository.ts";
export { CreateBuildUseCase, type CreateBuildRequest } from "./application/usecases/CreateBuildUseCase.ts";
export { ClaimNextBuildUseCase, type ClaimNextBuildRequest } from "./application/usecases/ClaimNextBuildUseCase.ts";
export { CompleteBuildUseCase, type CompleteBuildRequest } from "./application/usecases/CompleteBuildUseCase.ts";
export { GetBuildUseCase } from "./application/usecases/GetBuildUseCase.ts";
export { InMemoryBuildRepository } from "./infrastructure/InMemoryBuildRepository.ts";
export { PostgresBuildRepository } from "./infrastructure/PostgresBuildRepository.ts";
