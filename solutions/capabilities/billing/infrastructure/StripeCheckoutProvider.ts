// The real CheckoutSessionProvider, over Stripe's REST API directly via
// fetch — no `stripe` npm SDK. This repo already reaches for Bun/fetch
// natives over heavy SDKs elsewhere (Bun.S3Client instead of aws-sdk,
// Bun.SQL instead of an ORM); Stripe's Checkout Sessions API is one POST
// with a handful of fields, not worth a dependency for.
//
// Stripe's API takes application/x-www-form-urlencoded, not JSON — nested
// keys use PHP-style bracket notation (line_items[0][price]=...). Getting
// that wrong fails the request with a real, specific Stripe error, not a
// silent misconfiguration, so this has been checked directly against
// Stripe's own API reference rather than guessed.
//
// metadata.orgId/metadata.plan on the session is how the webhook handler
// (ConfirmPlanUpgradeUseCase's caller in routes.ts) knows which org and
// plan a completed session was for — Stripe echoes metadata back on the
// `checkout.session.completed` event's session object unchanged.

import type { PlanId } from "../domain/value-objects/Plan.ts";
import type { CheckoutSession, CheckoutSessionProvider } from "../application/ports/CheckoutSessionProvider.ts";

export class StripeApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Stripe API returned ${status}: ${body}`);
  }
}

export interface StripeConfig {
  readonly secretKey: string;
  /** Stripe Price ids (`price_...`), one per paid plan — "free" has none, upgrading to it doesn't go through Checkout. */
  readonly priceIds: Partial<Record<PlanId, string>>;
  readonly apiBase?: string; // overridable for tests only; real callers never set this.
}

export class NoPriceConfiguredError extends Error {
  constructor(readonly plan: PlanId) {
    super(`no Stripe price id configured for plan "${plan}"`);
  }
}

export class StripeCheckoutProvider implements CheckoutSessionProvider {
  constructor(private readonly config: StripeConfig) {}

  async createSession(orgId: string, plan: PlanId, successUrl: string, cancelUrl: string): Promise<CheckoutSession> {
    const priceId = this.config.priceIds[plan];
    if (!priceId) throw new NoPriceConfiguredError(plan);

    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: orgId,
      "metadata[orgId]": orgId,
      "metadata[plan]": plan,
    });

    const res = await fetch(`${this.config.apiBase ?? "https://api.stripe.com"}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) throw new StripeApiError(res.status, await res.text());

    const session = (await res.json()) as { url: string | null };
    if (!session.url) throw new StripeApiError(res.status, "session created with no url");
    return { url: session.url };
  }
}
