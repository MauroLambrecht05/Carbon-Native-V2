import type { PlanId } from "../../domain/value-objects/Plan.ts";

export interface PlanRepository {
  /** DEFAULT_PLAN if the org has never been assigned one. */
  getPlan(orgId: string): Promise<PlanId>;
  setPlan(orgId: string, plan: PlanId): Promise<void>;
}
