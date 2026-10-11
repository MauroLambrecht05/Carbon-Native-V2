// Stripe's event JSON, reduced to a BillingEvent. Only the fields Cloud acts
// on are read, and each is checked: a body that passed the signature check is
// still not trusted to have the right shape.

import type { BillingEvent, InvoiceStatus } from '../domain/Subscription.ts';

const text = (value: unknown, max = 255): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);
const time = (value: unknown): Date | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4102444800 ? new Date(value * 1000) : null);
const INVOICE: Record<string, InvoiceStatus> = { 'invoice.finalized': 'open', 'invoice.paid': 'paid', 'invoice.payment_failed': 'failed', 'invoice.voided': 'void' };
const STATUS: Record<string, 'active' | 'past_due' | 'ended' | 'incomplete'> = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'ended', incomplete_expired: 'ended', incomplete: 'incomplete', paused: 'past_due' };

/** Returns undefined when the body is not a Stripe event at all. */
export function parseStripeEvent(rawBody: string): BillingEvent | undefined {
  let value: any; try { value = JSON.parse(rawBody); } catch { return undefined; }
  const id = text(value?.id); const type = text(value?.type, 100); const occurredAt = time(value?.created); const object = value?.data?.object;
  if (!id || !type || !occurredAt || !object || typeof object !== 'object') return undefined;
  const base = { id, type, occurredAt }; const other: BillingEvent = { ...base, kind: 'other' };
  if (type === 'checkout.session.completed') {
    const sessionId = text(object.id); const customerId = text(object.customer); const subscriptionId = text(object.subscription);
    return sessionId && customerId && subscriptionId ? { ...base, kind: 'checkout_completed', sessionId, customerId, subscriptionId } : other;
  }
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
    const subscriptionId = text(object.id); const status = STATUS[String(object.status)];
    return subscriptionId && status ? { ...base, kind: 'subscription_changed', subscriptionId, status, cancelAtPeriodEnd: object.cancel_at_period_end === true, currentPeriodEnd: time(object.current_period_end) } : other;
  }
  if (type === 'customer.subscription.deleted') { const subscriptionId = text(object.id); return subscriptionId ? { ...base, kind: 'subscription_deleted', subscriptionId } : other; }
  if (type in INVOICE) {
    const invoiceId = text(object.id); const amount = object.amount_due; const currency = text(object.currency, 3)?.toLowerCase(); const hosted = text(object.hosted_invoice_url, 2048);
    if (!invoiceId || !Number.isSafeInteger(amount) || amount < 0 || !currency || !/^[a-z]{3}$/.test(currency)) return other;
    return { ...base, kind: 'invoice', invoice: { invoiceId, subscriptionId: text(object.subscription) ?? null, status: INVOICE[type]!, amountCents: amount, currency, number: text(object.number, 100) ?? null,
      hostedUrl: hosted?.startsWith('https://') ? hosted : null, periodStart: time(object.period_start), periodEnd: time(object.period_end) } };
  }
  return other;
}
