import { UsageRecord } from "../domain/entities/UsageRecord.ts";
import { DEFAULT_PLAN, type PlanId } from "../domain/value-objects/Plan.ts";
import type { UsageRepository } from "../application/ports/UsageRepository.ts";
import type { PlanRepository } from "../application/ports/PlanRepository.ts";

export class PostgresBillingRepository implements UsageRepository, PlanRepository {
  constructor(private readonly sql: Bun.SQL) {}

  async save(record: UsageRecord): Promise<void> {
    const p = record.toProps();
    await this.sql`
      INSERT INTO usage_records (id, org_id, build_id, duration_ms, recorded_at)
      VALUES (${p.id}, ${p.orgId}, ${p.buildId}, ${p.durationMs}, ${p.recordedAt})
    `;
  }

  async sumMinutesForOrg(orgId: string, since: Date): Promise<number> {
    const rows = await this.sql<Array<{ total_ms: number | null }>>`
      SELECT COALESCE(SUM(duration_ms), 0) AS total_ms FROM usage_records
      WHERE org_id = ${orgId} AND recorded_at >= ${since}
    `;
    return Number(rows[0]?.total_ms ?? 0) / 60_000;
  }

  async getPlan(orgId: string): Promise<PlanId> {
    const rows = await this.sql<Array<{ plan: PlanId }>>`
      SELECT plan FROM org_plans WHERE org_id = ${orgId}
    `;
    return rows[0]?.plan ?? DEFAULT_PLAN;
  }

  async setPlan(orgId: string, plan: PlanId): Promise<void> {
    await this.sql`
      INSERT INTO org_plans (org_id, plan) VALUES (${orgId}, ${plan})
      ON CONFLICT (org_id) DO UPDATE SET plan = EXCLUDED.plan
    `;
  }
}
