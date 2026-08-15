import type { InstallerTargetId } from "@carbon/contracts/distribution";
import { Build } from "../../domain/entities/Build.ts";
import type { BuildRepository } from "../ports/BuildRepository.ts";

export interface CreateBuildRequest {
  readonly orgId: string;
  readonly repoUrl: string;
  readonly commitSha: string;
  readonly targets: readonly InstallerTargetId[];
}

export class CreateBuildUseCase {
  constructor(private readonly builds: BuildRepository) {}

  async execute(request: CreateBuildRequest): Promise<Build> {
    const build = Build.queue({ id: crypto.randomUUID(), ...request });
    await this.builds.save(build);
    return build;
  }
}
