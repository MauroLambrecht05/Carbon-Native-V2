// Where a worker reports back — success with artifacts, or a reason it
// failed. Also where "running" gets recorded: a worker calls execute() with
// no outcome yet to mark the claimed build as actively executing, which is
// how a build that was claimed but whose worker died before finishing is
// told apart from one that's genuinely in progress.

import type { BuildArtifact } from "../../domain/entities/Build.ts";
import { BuildNotFoundError } from "../../domain/errors/BuildNotFoundError.ts";
import type { BuildRepository } from "../ports/BuildRepository.ts";

export type CompleteBuildRequest =
  | { readonly buildId: string; readonly outcome: "running" }
  | { readonly buildId: string; readonly outcome: "succeeded"; readonly artifacts: readonly BuildArtifact[] }
  | { readonly buildId: string; readonly outcome: "failed"; readonly error: string };

export class CompleteBuildUseCase {
  constructor(private readonly builds: BuildRepository) {}

  /** @throws BuildNotFoundError | InvalidTransitionError */
  async execute(request: CompleteBuildRequest): Promise<void> {
    const build = await this.builds.findById(request.buildId);
    if (!build) throw new BuildNotFoundError(request.buildId);

    switch (request.outcome) {
      case "running":
        build.start();
        break;
      case "succeeded":
        build.succeed(request.artifacts);
        break;
      case "failed":
        build.fail(request.error);
        break;
    }

    await this.builds.save(build);
  }
}
