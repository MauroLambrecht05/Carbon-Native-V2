import { PLANS } from "../../domain/value-objects/Plan.ts";
import type { PlanRepository } from "../ports/PlanRepository.ts";
import type { UsageRepository } from "../ports/UsageRepository.ts";

export interface UsageStatus {
  readonly withinLimit: boolean;
  readonly usedMinutes: number;
  readonly includedMinutes: number;
}

/** The current calendar month's start, in UTC — what "per month" resets against. */
function currentBillingPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class CheckUsageLimitUseCase {
  constructor(private readonly plans: PlanRepository, private readonly usage: UsageRepository) {}

  async execute(orgId: string): Promise<UsageStatus> {
    const plan = PLANS[await this.plans.getPlan(orgId)];
    const usedMinutes = await this.usage.sumMinutesForOrg(orgId, currentBillingPeriodStart());
    return {
      withinLimit: usedMinutes < plan.includedBuildMinutesPerMonth,
      usedMinutes,
      includedMinutes: plan.includedBuildMinutesPerMonth,
    };
  }
}
