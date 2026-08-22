// An in-process BuildRepository, for tests. No real atomicity guarantee
// under concurrency — single-threaded JS make the naive read-then-write in
// claimNext safe enough for a test double, which is the only place this is
// used. PostgresBuildRepository is what actually has to be safe under
// concurrent workers.

import { installerTarget, type TargetPlatform } from "@carbon/contracts/distribution";
import { Build } from "../domain/entities/Build.ts";
import type { BuildRepository } from "../application/ports/BuildRepository.ts";

export class InMemoryBuildRepository implements BuildRepository {
  private readonly rows = new Map<string, Build>();

  async save(build: Build): Promise<void> {
    this.rows.set(build.id, build);
  }

  async findById(id: string): Promise<Build | null> {
    return this.rows.get(id) ?? null;
  }

  async claimNext(platform: TargetPlatform, workerId: string, orgId: string): Promise<Build | null> {
    const queued = [...this.rows.values()]
      .filter((b) => b.status === "queued")
      .filter((b) => b.toProps().orgId === orgId)
      .filter((b) => b.toProps().targets.some((t) => installerTarget(t)?.platform === platform))
      .sort((a, b) => a.toProps().createdAt.getTime() - b.toProps().createdAt.getTime());

    const next = queued[0];
    if (!next) return null;

    next.claim(workerId);
    return next;
  }

  async listByOrg(orgId: string, limit: number): Promise<Build[]> {
    return [...this.rows.values()]
      .filter((b) => b.toProps().orgId === orgId)
      .sort((a, b) => b.toProps().createdAt.getTime() - a.toProps().createdAt.getTime())
      .slice(0, limit);
  }
}
