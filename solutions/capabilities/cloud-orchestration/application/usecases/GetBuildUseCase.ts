import type { Build } from "../../domain/entities/Build.ts";
import { BuildNotFoundError } from "../../domain/errors/BuildNotFoundError.ts";
import type { BuildRepository } from "../ports/BuildRepository.ts";

export class GetBuildUseCase {
  constructor(private readonly builds: BuildRepository) {}

  /** @throws BuildNotFoundError */
  async execute(id: string): Promise<Build> {
    const build = await this.builds.findById(id);
    if (!build) throw new BuildNotFoundError(id);
    return build;
  }
}
