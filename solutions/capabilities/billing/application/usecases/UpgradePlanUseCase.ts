import type { PlanId } from "../../domain/value-objects/Plan.ts";
import type { PlanRepository } from "../ports/PlanRepository.ts";
import type { PaymentProvider } from "../ports/PaymentProvider.ts";

export class ChargeFailedError extends Error {
  constructor(readonly orgId: string, readonly plan: PlanId) {
    super(`charge failed for org ${orgId} upgrading to ${plan}`);
  }
}

export class UpgradePlanUseCase {
  constructor(private readonly plans: PlanRepository, private readonly payments: PaymentProvider) {}

  /** @throws ChargeFailedError */
  async execute(orgId: string, plan: PlanId): Promise<void> {
    const result = await this.payments.chargeForPlan(orgId, plan);
    if (!result.success) throw new ChargeFailedError(orgId, plan);
    await this.plans.setPlan(orgId, plan);
  }
}
