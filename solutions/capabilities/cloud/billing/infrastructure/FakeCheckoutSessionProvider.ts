// Always returns a fake URL synchronously — no real Stripe account
// involved. Exists so StartPlanUpgradeUseCase has something to compose
// against in dev/tests without needing STRIPE_SECRET_KEY set; see
// StripeCheckoutProvider for the real one.

import type { PlanId } from "../domain/value-objects/Plan.ts";
import type { CheckoutSession, CheckoutSessionProvider } from "../application/ports/CheckoutSessionProvider.ts";

export class FakeCheckoutSessionProvider implements CheckoutSessionProvider {
  async createSession(orgId: string, plan: PlanId, successUrl: string): Promise<CheckoutSession> {
    // successUrl already carries its own query string (routes.ts builds it
    // as `${origin}/?checkout=success`) — a bare `?` here would produce an
    // invalid double query string. Found running this against a real
    // control plane, not by inspection.
    const url = new URL(successUrl);
    url.searchParams.set("fake_session", crypto.randomUUID());
    url.searchParams.set("org", orgId);
    url.searchParams.set("plan", plan);
    return { url: url.toString() };
  }
}
