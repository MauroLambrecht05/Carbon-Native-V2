// Always succeeds. Explicitly not Stripe/Paddle/anything real — see the
// note on the PaymentProvider port. Exists so UpgradePlanUseCase has
// something to compose against and can be tested end to end; wiring a real
// processor is separate, follow-up work, not a detail hidden in here.

import type { PaymentProvider, ChargeResult } from "../application/ports/PaymentProvider.ts";

export class FakePaymentProvider implements PaymentProvider {
  async chargeForPlan(): Promise<ChargeResult> {
    return { success: true, reference: `fake_${crypto.randomUUID()}` };
  }
}
