// @carbon/billing — usage metering and plans for Carbon Cloud.
//
//   domain/               Plan (a lookup table), UsageRecord
//   application/ports/    UsageRepository, PlanRepository, PaymentProvider
//   application/usecases/ record usage, check the limit, upgrade a plan
//   infrastructure/       InMemory + Postgres, and FakePaymentProvider —
//                         no real payment processor is wired up yet, see
//                         PaymentProvider.ts's own note.

export { PLANS, DEFAULT_PLAN, type Plan, type PlanId } from "./domain/value-objects/Plan.ts";
export { UsageRecord, type UsageRecordProps } from "./domain/entities/UsageRecord.ts";
export type { UsageRepository } from "./application/ports/UsageRepository.ts";
export type { PlanRepository } from "./application/ports/PlanRepository.ts";
export type { PaymentProvider, ChargeResult } from "./application/ports/PaymentProvider.ts";
export { RecordBuildUsageUseCase } from "./application/usecases/RecordBuildUsageUseCase.ts";
export { CheckUsageLimitUseCase, type UsageStatus } from "./application/usecases/CheckUsageLimitUseCase.ts";
export { UpgradePlanUseCase, ChargeFailedError } from "./application/usecases/UpgradePlanUseCase.ts";
export { InMemoryBillingRepository } from "./infrastructure/InMemoryBillingRepository.ts";
export { PostgresBillingRepository } from "./infrastructure/PostgresBillingRepository.ts";
export { FakePaymentProvider } from "./infrastructure/FakePaymentProvider.ts";
