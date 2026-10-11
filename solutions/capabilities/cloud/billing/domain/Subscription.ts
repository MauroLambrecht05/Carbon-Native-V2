// What a provider event does to Cloud's picture of a subscription.
//
// This is a pure function of the current picture and one event. It does not
// know which provider the event came from, and it never looks at the clock:
// the only time that matters is the provider's own time for the event, so
// events delivered late or twice or out of order give the same result.

import type { PlanId } from './value-objects/Plan.ts';

export type SubscriptionState = 'free' | 'checkout_pending' | 'active' | 'past_due' | 'cancel_scheduled' | 'ended';
export interface Subscription {
  readonly state: SubscriptionState;
  readonly plan: PlanId;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly currentPeriodEnd: Date | null;
  /** The provider's time of the newest event applied. */
  readonly lastEventAt: Date | null;
}
export const FREE: Subscription = { state: 'free', plan: 'free', providerCustomerId: null, providerSubscriptionId: null, currentPeriodEnd: null, lastEventAt: null };

export type InvoiceStatus = 'open' | 'paid' | 'failed' | 'void';
export interface InvoiceFacts {
  readonly invoiceId: string; readonly subscriptionId: string | null; readonly status: InvoiceStatus; readonly amountCents: number; readonly currency: string;
  readonly number: string | null; readonly hostedUrl: string | null; readonly periodStart: Date | null; readonly periodEnd: Date | null;
}
/** A provider event, reduced to what Cloud acts on. Anything else is `other`. */
export type BillingEvent = { readonly id: string; readonly type: string; readonly occurredAt: Date } & (
  | { readonly kind: 'checkout_completed'; readonly sessionId: string; readonly customerId: string; readonly subscriptionId: string }
  | { readonly kind: 'subscription_changed'; readonly subscriptionId: string; readonly status: 'active' | 'past_due' | 'ended' | 'incomplete'; readonly cancelAtPeriodEnd: boolean; readonly currentPeriodEnd: Date | null }
  | { readonly kind: 'subscription_deleted'; readonly subscriptionId: string }
  | { readonly kind: 'invoice'; readonly invoice: InvoiceFacts }
  | { readonly kind: 'other' });

/** The plan an organization is entitled to. A subscription that is late on payment keeps its plan until the provider ends it. */
export function entitledPlan(subscription: Subscription): PlanId { return ['active', 'past_due', 'cancel_scheduled'].includes(subscription.state) ? subscription.plan : 'free'; }
/** Whether the provider may still charge for this subscription. An organization in this state is not finally deleted. */
export const billable = (state: SubscriptionState) => state === 'active' || state === 'past_due' || state === 'cancel_scheduled';

/**
 * The subscription after one event, or `stale` when a newer event has already been applied, or `unhandled` when the
 * event does not change a subscription. `checkoutPlan` is the plan of the checkout the event completes.
 */
export function project(current: Subscription, event: BillingEvent, checkoutPlan?: PlanId): Subscription | 'stale' | 'unhandled' {
  if (event.kind === 'other') return 'unhandled';
  // The provider's order, not the order of arrival. An event from the same second is applied.
  if (current.lastEventAt && event.occurredAt.getTime() < current.lastEventAt.getTime()) return 'stale';
  const at = { lastEventAt: event.occurredAt };
  switch (event.kind) {
    case 'checkout_completed':
      if (!checkoutPlan || checkoutPlan === 'free') return 'unhandled';
      return { state: 'active', plan: checkoutPlan, providerCustomerId: event.customerId, providerSubscriptionId: event.subscriptionId, currentPeriodEnd: current.currentPeriodEnd, ...at };
    case 'subscription_changed': {
      if (event.status === 'incomplete') return 'unhandled';
      if (event.status === 'ended') return { ...current, state: 'ended', plan: 'free', currentPeriodEnd: event.currentPeriodEnd, ...at };
      // A paid plan is only ever granted by a completed checkout. A status change keeps the plan; it cannot create one.
      if (current.plan === 'free') return 'unhandled';
      const state = event.status === 'past_due' ? 'past_due' : event.cancelAtPeriodEnd ? 'cancel_scheduled' : 'active';
      return { ...current, state, currentPeriodEnd: event.currentPeriodEnd, ...at };
    }
    case 'subscription_deleted': return { ...current, state: 'ended', plan: 'free', ...at };
    case 'invoice':
      if (event.invoice.status === 'failed' && (current.state === 'active' || current.state === 'cancel_scheduled')) return { ...current, state: 'past_due', ...at };
      if (event.invoice.status === 'paid' && current.state === 'past_due') return { ...current, state: 'active', ...at };
      return 'unhandled';
  }
}
