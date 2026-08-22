import type { TargetPlatform } from "@carbon/contracts/distribution";
import type { Build } from "../../domain/entities/Build.ts";
import type { BuildRepository } from "../ports/BuildRepository.ts";

export interface ClaimNextBuildRequest {
  readonly platform: TargetPlatform;
  readonly workerId: string;
  readonly orgId: string;
}

export class ClaimNextBuildUseCase {
  constructor(private readonly builds: BuildRepository) {}

  /** Null when there's nothing queued for this org+platform right now. */
  async execute(request: ClaimNextBuildRequest): Promise<Build | null> {
    return this.builds.claimNext(request.platform, request.workerId, request.orgId);
  }
}
