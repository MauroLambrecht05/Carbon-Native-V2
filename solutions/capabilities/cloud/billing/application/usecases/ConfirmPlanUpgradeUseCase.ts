import type { PlanId } from "../../domain/value-objects/Plan.ts";
import type { PlanRepository } from "../ports/PlanRepository.ts";

export class ConfirmPlanUpgradeUseCase {
  constructor(private readonly plans: PlanRepository) {}

  /**
   * The only place a plan actually changes. Called from the webhook route
   * once Stripe confirms `checkout.session.completed` — never from the
   * browser's redirect back to successUrl, which a user can reach without
   * having paid (closing the tab after Stripe declines the card still
   * bounces back to successUrl in some flows).
   */
  async execute(orgId: string, plan: PlanId): Promise<void> {
    await this.plans.setPlan(orgId, plan);
  }
}
