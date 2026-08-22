// The boundary where a real payment processor (Stripe Checkout, a hosted
// page) plugs in. Replaces the old synchronous PaymentProvider.chargeForPlan
// port: that shape assumed a backend call could charge a card directly,
// which doesn't fit how a real processor works at all — real card
// collection is PCI-restricted to client-side tokenization, and Stripe's
// own recommended default for that is a hosted Checkout page, not a raw
// server-side charge. A Checkout flow is inherently two-step and
// asynchronous — create a session, redirect the browser to it, and only
// trust a plan change once Stripe's webhook confirms payment (never the
// browser's return to successUrl, which a user can hit without paying) —
// see StartPlanUpgradeUseCase / ConfirmPlanUpgradeUseCase for the split.

import type { PlanId } from "../../domain/value-objects/Plan.ts";

export interface CheckoutSession {
  readonly url: string;
}

export interface CheckoutSessionProvider {
  createSession(
    orgId: string,
    plan: PlanId,
    successUrl: string,
    cancelUrl: string,
  ): Promise<CheckoutSession>;
}
