// The boundary where a real payment processor (Stripe, Paddle) would plug
// in. No real implementation exists yet — infrastructure/FakePaymentProvider.ts
// is a stand-in that always succeeds, explicitly not wired to a real
// processor. Upgrading a plan today changes the stored PlanId and nothing
// else; money does not actually move. Said here rather than left to be
// discovered the hard way.

import type { PlanId } from "../../domain/value-objects/Plan.ts";

export interface ChargeResult {
  readonly success: boolean;
  readonly reference: string;
}

export interface PaymentProvider {
  chargeForPlan(orgId: string, plan: PlanId): Promise<ChargeResult>;
}
