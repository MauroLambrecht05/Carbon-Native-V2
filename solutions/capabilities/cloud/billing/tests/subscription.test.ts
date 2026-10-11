import { describe, expect, test } from 'bun:test';
import { FREE, billable, entitledPlan, parseStripeEvent, project, type BillingEvent, type Subscription } from '../index.ts';

const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1000);
const base = (seconds: number) => ({ id: `evt_${seconds}`, type: 'test', occurredAt: at(seconds) });
const checkout = (seconds: number): BillingEvent => ({ ...base(seconds), kind: 'checkout_completed', sessionId: 'cs_1', customerId: 'cus_1', subscriptionId: 'sub_1' });
const changed = (seconds: number, status: 'active' | 'past_due' | 'ended' | 'incomplete', cancelAtPeriodEnd = false): BillingEvent => ({ ...base(seconds), kind: 'subscription_changed', subscriptionId: 'sub_1', status, cancelAtPeriodEnd, currentPeriodEnd: at(9999) });
const invoice = (seconds: number, status: 'open' | 'paid' | 'failed' | 'void'): BillingEvent => ({ ...base(seconds), kind: 'invoice', invoice: { invoiceId: 'in_1', subscriptionId: 'sub_1', status, amountCents: 2900, currency: 'usd', number: null, hostedUrl: null, periodStart: null, periodEnd: null } });
const state = (value: Subscription | 'stale' | 'unhandled') => (typeof value === 'string' ? value : `${value.state}/${value.plan}`);
/** Applies events in the order given, keeping the subscription when an event changes nothing. */
const run = (events: BillingEvent[], start: Subscription = FREE) => events.reduce((current, event) => { const next = project(current, event, 'pro'); return typeof next === 'string' ? current : next; }, start);

describe('subscription projection', () => {
  test('each event moves the subscription as documented, and only a completed checkout grants a plan', () => {
    const active = run([checkout(10)]); expect(state(active)).toBe('active/pro'); expect(active).toMatchObject({ providerCustomerId: 'cus_1', providerSubscriptionId: 'sub_1', lastEventAt: at(10) });
    expect(state(project(active, changed(20, 'past_due')))).toBe('past_due/pro'); expect(state(project(active, changed(20, 'active', true)))).toBe('cancel_scheduled/pro'); expect(state(project(active, changed(20, 'ended')))).toBe('ended/free');
    expect(state(project(active, { ...base(20), kind: 'subscription_deleted', subscriptionId: 'sub_1' }))).toBe('ended/free'); expect(state(project(active, changed(20, 'incomplete')))).toBe('unhandled');
    expect(state(project(active, invoice(20, 'failed')))).toBe('past_due/pro'); expect(state(project(run([checkout(10), changed(20, 'active', true)]), invoice(30, 'failed')))).toBe('past_due/pro');
    expect(state(project(run([checkout(10), invoice(20, 'failed')]), invoice(30, 'paid')))).toBe('active/pro');
    // An invoice that changes nothing about the subscription: paid while active, opened, voided.
    for (const status of ['paid', 'open', 'void'] as const) expect(state(project(active, invoice(20, status)))).toBe('unhandled');
    expect(state(project(active, { ...base(20), kind: 'other' }))).toBe('unhandled');
    // Without a checkout there is no plan to keep: a status event alone grants nothing, from free or from ended.
    expect(state(project(FREE, changed(20, 'active')))).toBe('unhandled'); expect(state(project(run([checkout(10), changed(20, 'ended')]), changed(30, 'active')))).toBe('unhandled');
    expect(state(project(FREE, checkout(10)))).toBe('unhandled'); expect(state(project(FREE, checkout(10), 'free'))).toBe('unhandled');
    expect(state(project(FREE, invoice(10, 'failed')))).toBe('unhandled'); expect(state(project(FREE, changed(10, 'ended')))).toBe('ended/free');
  });

  test('the provider\'s time decides, not the order of arrival: any order of delivery ends in the same state', () => {
    const history = [checkout(10), changed(20, 'active'), invoice(30, 'failed'), invoice(40, 'paid'), changed(50, 'active', true), changed(60, 'ended')];
    expect(state(run(history))).toBe('ended/free');
    // The last event first: everything older is then stale and changes nothing.
    const last = project({ ...run([checkout(10)]) }, history.at(-1)!); expect(state(last)).toBe('ended/free');
    for (const older of history.slice(0, -1)) expect(state(project(last as Subscription, older, 'pro'))).toBe('stale');
    // An event from the same second as the newest one applied is applied; one a second older is not.
    const active = run([checkout(10)]); expect(state(project(active, changed(10, 'past_due')))).toBe('past_due/pro'); expect(state(project(active, changed(9, 'past_due')))).toBe('stale');
    // A redelivery of the newest event leaves the state where it is.
    expect(state(project(run(history), history.at(-1)!))).toBe('ended/free');
  });

  test('entitlement and billability follow the state', () => {
    const sub = (value: Subscription['state'], plan: 'free' | 'pro'): Subscription => ({ ...FREE, state: value, plan });
    expect((['free', 'checkout_pending', 'active', 'past_due', 'cancel_scheduled', 'ended'] as const).map(value => [value, entitledPlan(sub(value, value === 'active' || value === 'past_due' || value === 'cancel_scheduled' ? 'pro' : 'free')), billable(value)]))
      .toEqual([['free', 'free', false], ['checkout_pending', 'free', false], ['active', 'pro', true], ['past_due', 'pro', true], ['cancel_scheduled', 'pro', true], ['ended', 'free', false]]);
    // Whatever a row says, a state that is not live entitles to nothing.
    expect(entitledPlan(sub('ended', 'pro'))).toBe('free'); expect(entitledPlan(sub('checkout_pending', 'pro'))).toBe('free');
  });
});

describe('provider events', () => {
  const event = (type: string, object: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ id: 'evt_1', type, created: 1_800_000_000, data: { object }, ...extra });
  test('only well-formed events of known kinds are acted on', () => {
    expect(parseStripeEvent(event('checkout.session.completed', { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1' }))).toMatchObject({ kind: 'checkout_completed', sessionId: 'cs_1', customerId: 'cus_1', subscriptionId: 'sub_1', occurredAt: new Date(1_800_000_000_000) });
    expect(parseStripeEvent(event('customer.subscription.updated', { id: 'sub_1', status: 'trialing', cancel_at_period_end: true, current_period_end: 1_800_086_400 }))).toMatchObject({ kind: 'subscription_changed', status: 'active', cancelAtPeriodEnd: true });
    for (const [status, mapped] of [['unpaid', 'past_due'], ['canceled', 'ended'], ['incomplete_expired', 'ended'], ['incomplete', 'incomplete'], ['paused', 'past_due']]) expect(parseStripeEvent(event('customer.subscription.updated', { id: 'sub_1', status }))).toMatchObject({ status: mapped });
    expect(parseStripeEvent(event('customer.subscription.deleted', { id: 'sub_1' }))).toMatchObject({ kind: 'subscription_deleted' });
    expect(parseStripeEvent(event('invoice.payment_failed', { id: 'in_1', subscription: 'sub_1', amount_due: 2900, currency: 'USD', hosted_invoice_url: 'https://invoice.stripe.com/i/1', number: 'N-1' }))).toMatchObject({ kind: 'invoice', invoice: { status: 'failed', currency: 'usd', hostedUrl: 'https://invoice.stripe.com/i/1' } });
    // A known type with missing or wrong fields is kept as an event but acted on as nothing.
    for (const body of [event('checkout.session.completed', { id: 'cs_1' }), event('customer.subscription.updated', { id: 'sub_1', status: 'mystery' }), event('invoice.paid', { id: 'in_1', amount_due: -5, currency: 'usd' }),
      event('invoice.paid', { id: 'in_1', amount_due: 1.5, currency: 'usd' }), event('invoice.paid', { id: 'in_1', amount_due: 100, currency: 'dollars' }), event('customer.created', { id: 'cus_1' })]) expect(parseStripeEvent(body)).toMatchObject({ kind: 'other' });
    expect((parseStripeEvent(event('invoice.paid', { id: 'in_1', amount_due: 100, currency: 'usd', hosted_invoice_url: 'http://plain.example/i' })) as { invoice: { hostedUrl: unknown } }).invoice.hostedUrl).toBeNull();
    // Not an event at all.
    for (const body of ['', 'null', '[]', '{}', JSON.stringify({ id: 'evt_1', type: 'x', created: 'yesterday', data: { object: {} } }), JSON.stringify({ id: 'evt_1', type: 'x', created: 1_800_000_000 }), JSON.stringify({ id: '', type: 'x', created: 1, data: { object: {} } }),
      JSON.stringify({ id: 'e'.repeat(300), type: 'x', created: 1_800_000_000, data: { object: {} } })]) expect(parseStripeEvent(body)).toBeUndefined();
  });
});
