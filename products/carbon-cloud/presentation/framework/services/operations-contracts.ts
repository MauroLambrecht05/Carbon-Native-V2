import type { AccountContext, Action, Audit, CommandOptions, Page, PageRequest, RequestContext, Result, Scope } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type SubscriptionState = "free" | "checkout_pending" | "active" | "past_due" | "cancel_scheduled" | "ended";
export type Subscription = Readonly<{
  orgId: string; plan: "free" | "pro"; state: SubscriptionState;
  periodStart: string; periodEnd: string; revision: string;
  pendingPlan?: "free" | "pro"; cancelAt?: string; paymentMethod?: string;
  entitlements: Readonly<{ buildMinutes: number; storageBytes: number; functionInvocations: number; egressBytes: number }>;
}>;
export type UsageKind = "build_minutes" | "storage_bytes" | "function_invocations" | "egress_bytes";
export type UsageLine = Readonly<{
  id: string; orgId: string; projectId?: string; kind: UsageKind;
  quantity: string; classification: "metered" | "estimated" | "unavailable";
  periodStart: string; periodEnd: string; correlationId?: string;
}>;
export type Budget = Readonly<{
  id: string; orgId: string; kind: UsageKind; warningAt: number; hardCap?: number;
  current: number; state: "ok" | "warning" | "blocked"; revision: string;
}>;
export type Invoice = Readonly<{ id: string; orgId: string; number: string; status: "paid" | "open" | "void"; issuedAt: string; total: string; currency: "EUR"; fixtureDownload: string }>;
export type PlanPreview = Readonly<{
  plan: "free" | "pro"; fictionalPrice: string; includedBuildMinutes: number;
  conflicts: readonly string[]; effective: "provider_confirmation" | "period_end";
}>;
export type DeletionPreview = Readonly<{
  organization: string; blockers: readonly string[]; retained: readonly string[];
  immediatelyRemoved: readonly string[]; recoveryEndsAt: string;
}>;
export type BillingCommand =
  | { kind: "checkout.start"; plan: "pro" }
  | { kind: "provider.event"; eventId: string; outcome: "succeeded" | "failed" | "requires_action" }
  | { kind: "subscription.cancel" | "subscription.resume" }
  | { kind: "payment.update"; label: string }
  | { kind: "budget.save"; usageKind: UsageKind; warningAt: number; hardCap?: number }
  | { kind: "organization.delete.schedule"; confirmation: string }
  | { kind: "organization.delete.cancel" }
  | { kind: "downgrade.schedule"; plan: "free"; acceptGracePolicy: boolean };
export interface BillingService {
  getSubscription(context: RequestContext): Promise<Result<Subscription>>;
  listUsage(context: RequestContext, page?: PageRequest & { period?: string; projectId?: string }): Promise<Result<Page<UsageLine>>>;
  listBudgets(context: RequestContext): Promise<Result<readonly Budget[]>>;
  listInvoices(context: RequestContext, page?: PageRequest): Promise<Result<Page<Invoice>>>;
  previewPlan(context: RequestContext, plan: "free" | "pro"): Promise<Result<PlanPreview>>;
  command(context: RequestContext, input: BillingCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getLimits(context: RequestContext): Promise<Result<Readonly<{ scope: Scope; quotas: readonly { name: string; used: string; limit: string; state: "ok" | "warning" | "blocked"; consequence: string }[] }>>>;
  previewDeletion(context: RequestContext): Promise<Result<DeletionPreview>>;
}

export type OperatorJob = Readonly<{ id: string; kind: "provisioning" | "build" | "billing"; orgId: string; resourceId: string; state: "queued" | "running" | "failed" | "succeeded" | "cancelled"; attempt: number; lease?: string; reason?: string; revision: string }>;
export type ManagedWorker = Readonly<{ id: string; name: string; state: "available" | "busy" | "draining" | "offline"; heartbeatAt: string; capacity: number; activeLeases: number; revision: string }>;
export type RegistryReview = Readonly<{ id: string; packageId: string; versionId: string; state: "pending" | "approved" | "rejected"; evidence: readonly string[]; reason?: string; revision: string }>;
export type TrustKey = Readonly<{ id: string; fingerprint: string; state: "active" | "retiring" | "revoked"; impactedPackages: number; revision: string }>;
export type OperatorOrganization = Readonly<{ id: string; name: string; state: "active" | "suspended" | "deletion_scheduled"; reason?: string; recoveryAccess: boolean; customerDataAccess: false; revision: string }>;
export type OperatorCommand =
  | { kind: "job.retry" | "job.cancel"; id: string; reason: string }
  | { kind: "worker.register"; name: string; capacity: number }
  | { kind: "worker.drain" | "worker.resume"; id: string; reason: string }
  | { kind: "review.decide"; id: string; decision: "approved" | "rejected"; reason: string }
  | { kind: "trust.rotate"; reason: string }
  | { kind: "trust.revoke"; id: string; reason: string }
  | { kind: "organization.suspend" | "organization.resume"; id: string; reason: string }
  | { kind: "billing.adjust"; orgId: string; quantity: string; reason: string };
export interface OperatorService {
  listJobs(context?: AccountContext, page?: PageRequest): Promise<Result<Page<OperatorJob>>>;
  getJob(id: string, context?: AccountContext): Promise<Result<OperatorJob>>;
  listWorkers(context?: AccountContext, page?: PageRequest): Promise<Result<Page<ManagedWorker>>>;
  listReviews(context?: AccountContext, page?: PageRequest): Promise<Result<Page<RegistryReview>>>;
  listTrust(context?: AccountContext, page?: PageRequest): Promise<Result<Page<TrustKey>>>;
  getOrganization(id: string, context?: AccountContext): Promise<Result<OperatorOrganization>>;
  listAudit(context?: AccountContext, page?: PageRequest): Promise<Result<Page<Audit>>>;
  command(input: OperatorCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
}
