import { UsageRecord } from "../domain/entities/UsageRecord.ts";
import { DEFAULT_PLAN, type PlanId } from "../domain/value-objects/Plan.ts";
import type { UsageRepository } from "../application/ports/UsageRepository.ts";
import type { PlanRepository } from "../application/ports/PlanRepository.ts";

export class InMemoryBillingRepository implements UsageRepository, PlanRepository {
  private readonly records: UsageRecord[] = [];
  private readonly plans = new Map<string, PlanId>();

  async save(record: UsageRecord): Promise<void> {
    this.records.push(record);
  }

  async sumMinutesForOrg(orgId: string, since: Date): Promise<number> {
    const ms = this.records
      .filter((r) => r.toProps().orgId === orgId && r.toProps().recordedAt >= since)
      .reduce((sum, r) => sum + r.toProps().durationMs, 0);
    return ms / 60_000;
  }

  async getPlan(orgId: string): Promise<PlanId> {
    return this.plans.get(orgId) ?? DEFAULT_PLAN;
  }

  async setPlan(orgId: string, plan: PlanId): Promise<void> {
    this.plans.set(orgId, plan);
  }
}
