import type { PlanId } from "../../domain/value-objects/Plan.ts";
import type { CheckoutSessionProvider } from "../ports/CheckoutSessionProvider.ts";

export class StartPlanUpgradeUseCase {
  constructor(private readonly checkout: CheckoutSessionProvider) {}

  /**
   * Returns a URL to redirect the org to, not a completed upgrade — the
   * plan does not change here. It changes when Stripe's webhook confirms
   * the session actually got paid; see ConfirmPlanUpgradeUseCase.
   */
  async execute(orgId: string, plan: PlanId, successUrl: string, cancelUrl: string): Promise<{ url: string }> {
    return this.checkout.createSession(orgId, plan, successUrl, cancelUrl);
  }
}
