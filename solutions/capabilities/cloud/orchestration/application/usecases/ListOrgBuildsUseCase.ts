import type { Build } from "../../domain/entities/Build.ts";
import type { BuildRepository } from "../ports/BuildRepository.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class ListOrgBuildsUseCase {
  constructor(private readonly builds: BuildRepository) {}

  async execute(orgId: string, limit: number = DEFAULT_LIMIT): Promise<Build[]> {
    return this.builds.listByOrg(orgId, Math.min(Math.max(limit, 1), MAX_LIMIT));
  }
}
