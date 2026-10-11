// @carbon/billing — usage metering and plans for Carbon Cloud.
//
//   domain/               Plan (a lookup table), UsageRecord
//   application/ports/    UsageRepository, PlanRepository, CheckoutSessionProvider
//   application/usecases/ record usage, check the limit, start/confirm a
//                         plan upgrade (two steps — see StartPlanUpgradeUseCase's
//                         own note on why a Checkout flow can't be one call)
//   infrastructure/       InMemory + Postgres, FakeCheckoutSessionProvider
//                         for dev/tests, StripeCheckoutProvider for real —
//                         over Stripe's REST API directly, no SDK dependency.

export { PLANS, DEFAULT_PLAN, type Plan, type PlanId } from "./domain/value-objects/Plan.ts";
export { UsageRecord, type UsageRecordProps } from "./domain/entities/UsageRecord.ts";
export type { UsageRepository } from "./application/ports/UsageRepository.ts";
export type { PlanRepository } from "./application/ports/PlanRepository.ts";
export type { CheckoutSessionProvider, CheckoutSession } from "./application/ports/CheckoutSessionProvider.ts";
export { RecordBuildUsageUseCase } from "./application/usecases/RecordBuildUsageUseCase.ts";
export { CheckUsageLimitUseCase, type UsageStatus } from "./application/usecases/CheckUsageLimitUseCase.ts";
export { StartPlanUpgradeUseCase } from "./application/usecases/StartPlanUpgradeUseCase.ts";
export { ConfirmPlanUpgradeUseCase } from "./application/usecases/ConfirmPlanUpgradeUseCase.ts";
export { InMemoryBillingRepository } from "./infrastructure/InMemoryBillingRepository.ts";
export { PostgresBillingRepository } from "./infrastructure/PostgresBillingRepository.ts";
export { FakeCheckoutSessionProvider } from "./infrastructure/FakeCheckoutSessionProvider.ts";
export { StripeCheckoutProvider, StripeApiError, NoPriceConfiguredError, type StripeConfig } from "./infrastructure/StripeCheckoutProvider.ts";
export { verifyStripeWebhookSignature } from "./infrastructure/verifyStripeWebhookSignature.ts";

// Subscriptions from provider events, metered usage with budgets, and the account's view of both.
export { FREE, billable, entitledPlan, project, type BillingEvent, type InvoiceFacts, type InvoiceStatus, type Subscription, type SubscriptionState } from "./domain/Subscription.ts";
export { parseStripeEvent } from "./infrastructure/StripeEvents.ts";
export { PostgresBilling, UsageGate, type Meter, type WebhookOutcome } from "./infrastructure/PostgresBilling.ts";
export { AccountBilling, BillingWebhooks } from "./application/usecases/AccountBilling.ts";
