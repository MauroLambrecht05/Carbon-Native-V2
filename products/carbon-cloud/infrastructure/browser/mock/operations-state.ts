import type { Budget, Invoice, ManagedWorker, OperatorJob, OperatorOrganization, RegistryReview, Subscription, TrustKey, UsageLine } from "../../../presentation/framework/services/operations-contracts";
import type { MockState } from "./store";

export interface OperationsState {
  subscriptions: Record<string, Subscription>;
  usage: Record<string, UsageLine>;
  budgets: Record<string, Budget>;
  invoices: Record<string, Invoice>;
  providerEvents: Record<string, true>;
  jobs: Record<string, OperatorJob>;
  workers: Record<string, ManagedWorker>;
  reviews: Record<string, RegistryReview>;
  trust: Record<string, TrustKey>;
  organizations: Record<string, OperatorOrganization>;
  adjustments: Record<string, { id: string; orgId: string; quantity: string; reason: string; createdAt: string }>;
}
export function operationsState(state: MockState): OperationsState {
  if (!state.operationsAdmin) {
    const start = "2026-09-01T00:00:00.000Z", end = "2026-10-01T00:00:00.000Z";
    const subscriptions = Object.fromEntries(Object.values(state.organizations).map(org => [org.id, { orgId: org.id, plan: "free", state: "free", periodStart: start, periodEnd: end, revision: "r1", entitlements: { buildMinutes: 60, storageBytes: 1000000000, functionInvocations: 10000, egressBytes: 1000000000 } } satisfies Subscription]));
    const usage: Record<string, UsageLine> = {};
    for (const org of Object.values(state.organizations)) {
      const project = Object.values(state.projects).find(p => p.orgId === org.id);
      for (const [kind, quantity, classification] of [["build_minutes", "38", "metered"], ["storage_bytes", "248000000", "estimated"], ["function_invocations", "1840", "metered"], ["egress_bytes", "0", "unavailable"]] as const) {
        const id = `usage_${org.id}_${kind}`; usage[id] = { id, orgId: org.id, projectId: project?.id, kind, quantity, classification, periodStart: start, periodEnd: end, correlationId: classification === "metered" ? `fixture:${id}` : undefined };
      }
    }
    state.operationsAdmin = {
      subscriptions, usage, budgets: {}, providerEvents: {}, adjustments: {},
      invoices: { invoice_fixture: { id: "invoice_fixture", orgId: "org_north", number: "MOCK-2026-0001", status: "paid", issuedAt: start, total: "0.00", currency: "EUR", fixtureDownload: "data:text/plain;charset=utf-8,Carbon%20Cloud%20mock%20invoice%20%E2%80%94%20no%20financial%20transaction" } },
      jobs: { job_provision_failed: { id: "job_provision_failed", kind: "provisioning", orgId: "org_north", resourceId: "env_north_notes_staging", state: "failed", attempt: 1, reason: "Synthetic Database binding timeout", revision: "r1" }, job_build_stuck: { id: "job_build_stuck", kind: "build", orgId: "org_south", resourceId: "build_fixture_stuck", state: "running", attempt: 1, lease: "lease_fixture_expired", revision: "r1" } },
      workers: { worker_win_01: { id: "worker_win_01", name: "Windows pool 01", state: "busy", heartbeatAt: "2026-09-06T11:59:50.000Z", capacity: 2, activeLeases: 1, revision: "r1" } },
      reviews: { review_sqlite: { id: "review_sqlite", packageId: "pkg_carbon_sqlite", versionId: "pkgver_carbon_sqlite_1_2_0", state: "pending", evidence: ["Archive paths validated", "Windows DLL kind validated", "Signature metadata verified"], revision: "r1" } },
      trust: { trust_primary: { id: "trust_primary", fingerprint: "SHA256:MOCK-CARBON-PRIMARY", state: "active", impactedPackages: 1, revision: "r1" } },
      organizations: Object.fromEntries(Object.values(state.organizations).map(org => [org.id, { id: org.id, name: org.name, state: "active", recoveryAccess: true, customerDataAccess: false, revision: "r1" } satisfies OperatorOrganization])),
    };
  }
  for (const org of Object.values(state.organizations)) {
    state.operationsAdmin.subscriptions[org.id] ??= { orgId: org.id, plan: "free", state: "free", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z", revision: "r1", entitlements: { buildMinutes: 60, storageBytes: 1_000_000_000, functionInvocations: 10_000, egressBytes: 1_000_000_000 } };
    state.operationsAdmin.organizations[org.id] ??= { id: org.id, name: org.name, state: "active", recoveryAccess: true, customerDataAccess: false, revision: "r1" };
  }
  return state.operationsAdmin;
}
