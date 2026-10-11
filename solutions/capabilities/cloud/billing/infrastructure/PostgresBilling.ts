import { createHash, randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type BillingCommand, type BillingOverview, type BillingReceipt, type BillingSubscription, type BillingUsage } from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import { FREE, entitledPlan, project, type BillingEvent, type InvoiceFacts, type Subscription } from '../domain/Subscription.ts';
import { PLANS, type Plan, type PlanId } from '../domain/value-objects/Plan.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
export type Meter = 'build_minutes' | 'function_invocations';
export type WebhookOutcome = 'applied' | 'stale' | 'unmatched' | 'unhandled' | 'duplicate';
const INCLUDED: Record<Meter, (plan: Plan) => number> = { build_minutes: plan => plan.includedBuildMinutesPerMonth, function_invocations: plan => plan.includedFunctionInvocationsPerMonth };
const MONTH = `date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/**
 * Admission of charged work, and the record of what was used. One instance is shared by everything that charges, so
 * every meter is counted and limited the same way.
 */
export class UsageGate {
  constructor(private readonly plans: Record<PlanId, Plan> = PLANS) {}

  /** Serializes charged admissions of one organization for the rest of the transaction: counts taken after this are exact. */
  async lock(tx: Tx, orgId: string): Promise<void> { await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'usage:' + orgId}, 0))`; }
  async plan(tx: Tx, orgId: string): Promise<Plan> {
    const id = (await tx<{ plan: PlanId }[]>`SELECT plan FROM org_plans WHERE org_id = ${orgId}`)[0]?.plan;
    return this.plans[id ?? 'free'] ?? this.plans.free;
  }
  /** What the organization has used of a meter this calendar month (UTC). */
  async used(tx: Tx, orgId: string, meter: Meter): Promise<number> {
    return Number((await tx.unsafe(`SELECT COALESCE(sum(quantity), 0)::bigint::text AS total FROM usage_events WHERE org_id = $1 AND meter = $2 AND occurred_at >= ${MONTH}`, [orgId, meter]))[0].total);
  }
  /**
   * Decides whether more charged work may start. `committed` is everything already used this month, everything
   * reserved by work in progress, and the work being asked for. The plan's allowance is a hard limit. An
   * organization's own budget is a hard limit in `cap` mode, and a one-time notice in `warn` mode.
   */
  async admit(tx: Tx, orgId: string, meter: Meter, committed: number, requestId: string): Promise<void> {
    const included = INCLUDED[meter](await this.plan(tx, orgId));
    if (committed > included) throw new PlatformFault('quota', 'This organization has reached what its plan includes this month', { quota: meter });
    const budget = (await tx<Row[]>`SELECT monthly_limit, mode FROM usage_budgets WHERE org_id = ${orgId} AND meter = ${meter}`)[0];
    if (!budget || committed <= Number(budget.monthly_limit)) return;
    if (budget.mode === 'cap') throw new PlatformFault('quota', 'This organization has reached the budget it set for this month', { quota: meter, budget: 'cap' });
    // Said once per month, however many times the line is crossed.
    const first = await tx.unsafe(`INSERT INTO usage_warnings (org_id, meter, period) VALUES ($1, $2, (${MONTH})::date) ON CONFLICT DO NOTHING RETURNING 1`, [orgId, meter]);
    if (first.length) await event(tx, orgId, `billing.budget.warning.${meter}`, requestId);
  }
  /** Records that something charged happened. The source key names the thing; recording it again changes nothing. */
  async record(tx: Tx, orgId: string, meter: Meter, quantity: number, sourceKey: string): Promise<boolean> {
    if (quantity <= 0) return false;
    return (await tx`INSERT INTO usage_events (id, org_id, meter, quantity, source_key) VALUES (${randomUUID()}, ${orgId}, ${meter}, ${quantity}, ${sourceKey}) ON CONFLICT (source_key) DO NOTHING RETURNING 1`).length > 0;
  }
  included(plan: Plan, meter: Meter): number { return INCLUDED[meter](plan); }
}

/** A billing fact in the organization's own event log. It has no actor: the provider or a timer caused it. */
async function event(tx: Tx, orgId: string, action: string, requestId: string): Promise<void> {
  await tx`INSERT INTO platform_events (id, source, org_id, actor_kind, action, resource_kind, resource_id, request_id) VALUES (${randomUUID()}, 'billing', ${orgId}, 'system', ${action}, 'organization', ${orgId}, ${requestId})`;
}
function subscriptionOf(row: Row | undefined): Subscription {
  return row ? { state: row.state, plan: row.plan, providerCustomerId: row.provider_customer_id, providerSubscriptionId: row.provider_subscription_id, currentPeriodEnd: row.current_period_end, lastEventAt: row.last_event_at } : FREE;
}
function view(row: Row | undefined): BillingSubscription {
  return parseComponent('BillingSubscription', { state: row?.state ?? 'free', plan: row?.plan ?? 'free', currentPeriodEnd: row?.current_period_end?.toISOString() ?? null, revision: String(row?.revision ?? 1) });
}

export class PostgresBilling extends PostgresPlatformAuthority {
  constructor(sql: Bun.SQL, private readonly gate: UsageGate = new UsageGate()) { super(sql); }

  private async authorize(tx: Tx, input: OrganizationActor, orgId: string) {
    const access = await this.resolveInTransaction(tx, input, { orgId });
    // Billing is its own permission. Holding it gives no access to projects or their data, and data access does not give it.
    if (!access.permissions.includes('billing.manage')) throw new PlatformFault('forbidden', 'Billing is not permitted');
  }
  private async save(tx: Tx, orgId: string, next: Subscription, requestId: string): Promise<Row> {
    const row = (await tx<Row[]>`INSERT INTO billing_subscriptions (org_id, state, plan, provider, provider_customer_id, provider_subscription_id, current_period_end, last_event_at)
      VALUES (${orgId}, ${next.state}, ${next.plan}, ${next.providerSubscriptionId ? 'stripe' : null}, ${next.providerCustomerId}, ${next.providerSubscriptionId}, ${next.currentPeriodEnd}, ${next.lastEventAt})
      ON CONFLICT (org_id) DO UPDATE SET state = EXCLUDED.state, plan = EXCLUDED.plan, provider = EXCLUDED.provider, provider_customer_id = EXCLUDED.provider_customer_id, provider_subscription_id = EXCLUDED.provider_subscription_id,
        current_period_end = EXCLUDED.current_period_end, last_event_at = EXCLUDED.last_event_at, revision = billing_subscriptions.revision + 1, updated_at = now() RETURNING *`)[0]!;
    // What the rest of Cloud reads to decide what an organization may use.
    await tx`INSERT INTO org_plans (org_id, plan) VALUES (${orgId}, ${entitledPlan(next)}) ON CONFLICT (org_id) DO UPDATE SET plan = EXCLUDED.plan`;
    await event(tx, orgId, `billing.subscription.${next.state}`, requestId);
    return row;
  }
  private async invoice(tx: Tx, orgId: string, facts: InvoiceFacts, occurredAt: Date): Promise<boolean> {
    // An older event about an invoice never overwrites what a newer one said.
    return (await tx`INSERT INTO billing_invoices (provider, invoice_id, org_id, number, status, amount_cents, currency, hosted_url, period_start, period_end, last_event_at)
      VALUES ('stripe', ${facts.invoiceId}, ${orgId}, ${facts.number}, ${facts.status}, ${facts.amountCents}, ${facts.currency}, ${facts.hostedUrl}, ${facts.periodStart}, ${facts.periodEnd}, ${occurredAt})
      ON CONFLICT (provider, invoice_id) DO UPDATE SET number = EXCLUDED.number, status = EXCLUDED.status, amount_cents = EXCLUDED.amount_cents, hosted_url = EXCLUDED.hosted_url, period_start = EXCLUDED.period_start,
        period_end = EXCLUDED.period_end, last_event_at = EXCLUDED.last_event_at WHERE billing_invoices.last_event_at <= EXCLUDED.last_event_at AND billing_invoices.org_id = EXCLUDED.org_id RETURNING 1`).length > 0;
  }

  /**
   * Takes one verified provider event. The inbox row is written first, in the same transaction as everything the
   * event changes: a redelivery finds the row and does nothing, and a failure part-way leaves no row, so the
   * provider's retry is processed as if it were the first delivery.
   */
  async receive(billingEvent: BillingEvent, rawBody: string, requestId: string): Promise<WebhookOutcome> {
    return this.sql.begin(async tx => {
      const digest = createHash('sha256').update(rawBody).digest('hex');
      const fresh = await tx`INSERT INTO billing_webhook_events (provider, event_id, type, payload_digest, occurred_at, outcome) VALUES ('stripe', ${billingEvent.id}, ${billingEvent.type}, ${digest}, ${billingEvent.occurredAt}, 'unhandled')
        ON CONFLICT (provider, event_id) DO NOTHING RETURNING 1`;
      if (!fresh.length) return 'duplicate';
      let orgId: string | undefined; let checkoutPlan: PlanId | undefined;
      if (billingEvent.kind === 'checkout_completed') {
        const checkout = (await tx<Row[]>`SELECT * FROM billing_checkouts WHERE provider = 'stripe' AND provider_session_id = ${billingEvent.sessionId} FOR UPDATE`)[0];
        orgId = checkout?.org_id; checkoutPlan = checkout?.plan;
        if (checkout?.state === 'pending') await tx`UPDATE billing_checkouts SET state = 'completed' WHERE id = ${checkout.id}`;
      } else if (billingEvent.kind !== 'other') {
        const subscriptionId = billingEvent.kind === 'invoice' ? billingEvent.invoice.subscriptionId : billingEvent.subscriptionId;
        if (subscriptionId) orgId = (await tx<Row[]>`SELECT org_id FROM billing_subscriptions WHERE provider = 'stripe' AND provider_subscription_id = ${subscriptionId}`)[0]?.org_id;
      }
      let outcome: Exclude<WebhookOutcome, 'duplicate'> = billingEvent.kind === 'other' ? 'unhandled' : 'unmatched';
      if (orgId) {
        const current = subscriptionOf((await tx<Row[]>`SELECT * FROM billing_subscriptions WHERE org_id = ${orgId} FOR UPDATE`)[0]);
        const next = project(current, billingEvent, checkoutPlan);
        const recorded = billingEvent.kind === 'invoice' ? await this.invoice(tx, orgId, billingEvent.invoice, billingEvent.occurredAt) : false;
        if (typeof next === 'object') { await this.save(tx, orgId, next, requestId); outcome = 'applied'; }
        else outcome = recorded ? 'applied' : next;
      }
      await tx`UPDATE billing_webhook_events SET outcome = ${outcome}, org_id = ${orgId ?? null} WHERE provider = 'stripe' AND event_id = ${billingEvent.id}`;
      return outcome;
    });
  }

  private async usage(tx: Tx, orgId: string): Promise<BillingUsage[]> {
    const plan = await this.gate.plan(tx, orgId); const budgets = await tx<Row[]>`SELECT * FROM usage_budgets WHERE org_id = ${orgId}`;
    const reserved: Record<Meter, number> = {
      build_minutes: Number((await tx`SELECT COALESCE(sum(reserved_minutes), 0)::bigint::text AS total FROM platform_builds WHERE org_id = ${orgId} AND state IN ('queued', 'running')`)[0].total),
      function_invocations: Number((await tx`SELECT count(*)::text AS total FROM function_executions WHERE org_id = ${orgId} AND state IN ('queued', 'running')`)[0].total),
    };
    const rows: BillingUsage[] = [];
    for (const meter of ['build_minutes', 'function_invocations'] as const) {
      const budget = budgets.find(row => row.meter === meter);
      rows.push({ meter, used: await this.gate.used(tx, orgId, meter), reserved: reserved[meter], included: this.gate.included(plan, meter), budget: budget ? { monthlyLimit: Number(budget.monthly_limit), mode: budget.mode, revision: String(budget.revision) } : null });
    }
    return rows;
  }

  /** Subscription, this month's totals and invoice metadata. Aggregates only: nothing here names a project or its contents. */
  async overview(input: OrganizationActor, orgId: string): Promise<BillingOverview> {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, orgId);
      const invoices = await tx<Row[]>`SELECT * FROM billing_invoices WHERE org_id = ${orgId} ORDER BY created_at DESC, invoice_id LIMIT 24`;
      return parseComponent('BillingOverview', { subscription: view((await tx<Row[]>`SELECT * FROM billing_subscriptions WHERE org_id = ${orgId}`)[0]), usage: await this.usage(tx, orgId),
        invoices: invoices.map(row => ({ id: row.invoice_id, number: row.number, status: row.status, amountCents: Number(row.amount_cents), currency: row.currency, hostedUrl: row.hosted_url,
          periodStart: row.period_start?.toISOString() ?? null, periodEnd: row.period_end?.toISOString() ?? null })) });
    });
  }

  /** Checks that a checkout may start, before the provider is asked to create one. */
  async checkoutAllowed(input: OrganizationActor, orgId: string): Promise<void> {
    await this.sql.begin(async tx => {
      await this.authorize(tx, input, orgId);
      const state = (await tx<Row[]>`SELECT state FROM billing_subscriptions WHERE org_id = ${orgId}`)[0]?.state ?? 'free';
      if (['active', 'past_due', 'cancel_scheduled'].includes(state)) throw new PlatformFault('conflict', 'This organization already has a subscription');
    });
  }
  /** Remembers which organization a provider checkout session belongs to. Nothing is granted here: only the provider's event grants a plan. */
  async startCheckout(input: OrganizationActor, orgId: string, plan: 'pro', session: { id: string; url: string }, requestId: string): Promise<BillingReceipt> {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, orgId);
      const current = (await tx<Row[]>`SELECT * FROM billing_subscriptions WHERE org_id = ${orgId} FOR UPDATE`)[0];
      if (current && ['active', 'past_due', 'cancel_scheduled'].includes(current.state)) throw new PlatformFault('conflict', 'This organization already has a subscription');
      // One open checkout per organization: starting another abandons the one before it.
      await tx`UPDATE billing_checkouts SET state = 'abandoned' WHERE org_id = ${orgId} AND state = 'pending'`;
      await tx`INSERT INTO billing_checkouts (id, org_id, plan, provider, provider_session_id, created_by) VALUES (${randomUUID()}, ${orgId}, ${plan}, 'stripe', ${session.id}, ${input.accountId})`;
      const row = await this.save(tx, orgId, { ...subscriptionOf(current), state: 'checkout_pending', plan: 'free' }, requestId);
      return parseComponent('BillingReceipt', { subscription: view(row), checkoutUrl: session.url, message: 'Checkout started' });
    });
  }

  async budget(input: OrganizationActor, orgId: string, command: Extract<BillingCommand, { kind: 'budget' | 'budget-clear' }>, requestId: string): Promise<BillingReceipt> {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, orgId);
      if (command.kind === 'budget-clear') await tx`DELETE FROM usage_budgets WHERE org_id = ${orgId} AND meter = ${command.meter}`;
      else await tx`INSERT INTO usage_budgets (org_id, meter, monthly_limit, mode, updated_by) VALUES (${orgId}, ${command.meter}, ${command.monthlyLimit}, ${command.mode}, ${input.accountId})
        ON CONFLICT (org_id, meter) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, revision = usage_budgets.revision + 1, updated_at = now()`;
      await event(tx, orgId, command.kind === 'budget-clear' ? `billing.budget.cleared.${command.meter}` : `billing.budget.set.${command.meter}`, requestId);
      return parseComponent('BillingReceipt', { subscription: view((await tx<Row[]>`SELECT * FROM billing_subscriptions WHERE org_id = ${orgId}`)[0]), checkoutUrl: null, message: command.kind === 'budget-clear' ? 'Budget removed' : 'Budget saved' });
    });
  }

  /** Provider events Cloud accepted but could not tie to an organization. They are kept for an operator to resolve. */
  async unmatched(limit = 50): Promise<readonly { eventId: string; type: string; occurredAt: string }[]> {
    return (await this.sql<Row[]>`SELECT event_id, type, occurred_at FROM billing_webhook_events WHERE outcome = 'unmatched' ORDER BY received_at LIMIT ${limit}`).map(row => ({ eventId: row.event_id, type: row.type, occurredAt: row.occurred_at.toISOString() }));
  }
}
