import { PlatformFault, parseComponent, type BillingCommand, type BillingOverview, type BillingReceipt } from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type OrganizationActor } from '@carbon/identity';
import type { CheckoutSessionProvider } from '../ports/CheckoutSessionProvider.ts';
import type { PostgresBilling, WebhookOutcome } from '../../infrastructure/PostgresBilling.ts';
import { parseStripeEvent } from '../../infrastructure/StripeEvents.ts';
import { verifyStripeWebhookSignature } from '../../infrastructure/verifyStripeWebhookSignature.ts';

/** An organization's billing, for members who hold `billing.manage`, through the browser session. */
export class AccountBilling {
  constructor(private readonly auth: AccountAuthentication, private readonly billing: PostgresBilling, private readonly checkout: CheckoutSessionProvider, private readonly origin: string) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage billing');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision, permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  async overview(token: string, orgId: string): Promise<BillingOverview> { return this.billing.overview(await this.actor(token), parseComponent('Id', orgId)); }

  async command(token: string, csrf: string, orgId: string, value: BillingCommand, requestId: string): Promise<BillingReceipt> {
    parseComponent('Id', orgId); parseComponent('Id', requestId); const command = parseComponent('BillingCommand', value); const actor = await this.actor(token, csrf);
    if (command.kind !== 'checkout') return this.billing.budget(actor, orgId, command, requestId);
    await this.billing.checkoutAllowed(actor, orgId);
    // The provider is asked only after Cloud has decided the account may ask. Returning from the provider's page proves nothing; only its signed event grants the plan.
    const session = await this.checkout.createSession(orgId, command.plan, `${this.origin}/organizations/${orgId}/billing?checkout=success`, `${this.origin}/organizations/${orgId}/billing?checkout=cancelled`)
      .catch(() => { throw new PlatformFault('unavailable', 'The payment provider could not start a checkout'); });
    if (!session.id) throw new PlatformFault('unavailable', 'The payment provider returned no checkout session');
    return this.billing.startCheckout(actor, orgId, command.plan, { id: session.id, url: session.url }, requestId);
  }
}

/** The provider's side: signed events in, at most once each. */
export class BillingWebhooks {
  /** `secrets` are the provider's signing secrets. More than one is accepted while a secret is being rotated. */
  constructor(private readonly billing: PostgresBilling, private readonly secrets: readonly string[], private readonly toleranceSeconds = 300) {
    if (!secrets.length || secrets.some(secret => secret.length < 16)) throw new Error('A webhook signing secret is required');
  }
  async receive(rawBody: string, signature: string | null, requestId: string): Promise<WebhookOutcome> {
    // Nothing about the body is read, and nothing is stored, until the signature over these exact bytes verifies.
    if (!this.secrets.some(secret => verifyStripeWebhookSignature(rawBody, signature, secret, this.toleranceSeconds))) throw new PlatformFault('unauthenticated', 'Invalid webhook signature');
    const event = parseStripeEvent(rawBody);
    if (!event) throw new PlatformFault('validation', 'Invalid provider event');
    return this.billing.receive(event, rawBody, requestId);
  }
}
