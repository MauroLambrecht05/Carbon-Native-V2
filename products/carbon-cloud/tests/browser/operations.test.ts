import { afterEach, expect, test } from "bun:test";
import { createMockServices, type MockRuntime } from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap, type Result } from "../../presentation/framework/services/contracts";

const org = { orgId: "org_north" };
const project = { orgId: "org_north", projectId: "project_north_notes" };
let runtime: MockRuntime;
const code = (result: Result<unknown>) => result.ok ? undefined : result.error.code;
async function setup(identity = "owner", persistence?: MemoryPersistence) {
  runtime = createMockServices({ persistence: persistence ?? new MemoryPersistence(seedFoundation(1000)), wallTime: () => 1000, autoTick: false });
  unwrap(await runtime.tools.setLatency(0)); unwrap(await runtime.tools.selectIdentity(identity)); return runtime;
}
afterEach(() => runtime?.dispose());

test("billing plan changes require provider confirmation and duplicate events are idempotent", async () => {
  const app = await setup(); const billing = app.services.billing;
  expect(unwrap(await billing.getSubscription({ scope: org })).plan).toBe("free");
  unwrap(await billing.command({ scope: org }, { kind: "checkout.start", plan: "pro" }, { idempotencyKey: "checkout", expectedRevision: "r1" }));
  expect(unwrap(await billing.getSubscription({ scope: org })).state).toBe("checkout_pending");
  unwrap(await billing.command({ scope: org }, { kind: "provider.event", eventId: "provider-1", outcome: "succeeded" }, { idempotencyKey: "event" }));
  const active = unwrap(await billing.getSubscription({ scope: org })); expect(active.plan).toBe("pro"); expect(active.entitlements.buildMinutes).toBe(6000);
  expect(unwrap(await billing.command({ scope: org }, { kind: "provider.event", eventId: "provider-1", outcome: "failed" }, { idempotencyKey: "event-duplicate" })).message).toContain("ignored");
  expect(unwrap(await billing.getSubscription({ scope: org })).state).toBe("active");
});

test("billing-only members see aggregates but customer project metadata stays hidden", async () => {
  const app = await setup("billing");
  expect(unwrap(await app.services.billing.listUsage({ scope: org })).items.some(x => x.classification === "unavailable")).toBe(true);
  expect(code(await app.services.catalog.listProjects({ scope: org }))).toBe("forbidden");
  expect(code(await app.services.billing.previewDeletion({ scope: org }))).toBe("forbidden");
});

test("budget hard caps persist and block new charged builds without deleting existing state", async () => {
  const store = new MemoryPersistence(seedFoundation(1000)); const app = await setup("owner", store);
  unwrap(await app.services.billing.command({ scope: org }, { kind: "budget.save", usageKind: "build_minutes", warningAt: 1, hardCap: 38 }, { idempotencyKey: "cap" }));
  expect(unwrap(await app.services.billing.listBudgets({ scope: org }))[0].state).toBe("blocked");
  expect(unwrap(await app.services.identity.listNotifications()).items.some(x => x.name.includes("budget blocked"))).toBe(true);
  const request = { environmentId: "env_north_notes_development", ref: "main", formats: ["nsis" as const] };
  const preflight = unwrap(await app.services.delivery.getBuildPreflight({ scope: project }, request));
  expect(code(await app.services.delivery.startBuild({ scope: project }, request, { idempotencyKey: "blocked-build", expectedRevision: preflight.revision }))).toBe("quota_exceeded");
  runtime.dispose(); const reload = await setup("owner", store);
  expect(unwrap(await reload.services.billing.listBudgets({ scope: org }))[0].state).toBe("blocked");
});

test("operator audience is separate and actions preserve revision and audit reason", async () => {
  const customer = await setup(); expect(code(await customer.services.operator.listJobs())).toBe("forbidden");
  unwrap(await customer.tools.selectIdentity("operator"));
  const failed = unwrap(await customer.services.operator.getJob("job_provision_failed"));
  unwrap(await customer.services.operator.command({ kind: "job.retry", id: failed.id, reason: "Retry only failed binding" }, { idempotencyKey: "retry", expectedRevision: failed.revision }));
  const retried = unwrap(await customer.services.operator.getJob(failed.id)); expect(retried.state).toBe("queued"); expect(retried.attempt).toBe(2);
  expect(code(await customer.services.operator.command({ kind: "job.retry", id: failed.id, reason: "again" }, { idempotencyKey: "stale", expectedRevision: failed.revision }))).toBe("conflict");
  const audit = unwrap(await customer.services.operator.listAudit()); expect(audit.items.some(x => x.action === "job.retry" && x.metadata?.reason === "Retry only failed binding")).toBe(true);
  expect(unwrap(await customer.services.operator.getOrganization("org_north")).customerDataAccess).toBe(false);
});

test("operator suspension blocks charged customer writes but leaves metadata recovery visible", async () => {
  const app = await setup("operator"); const organization = unwrap(await app.services.operator.getOrganization("org_north"));
  unwrap(await app.services.operator.command({ kind: "organization.suspend", id: organization.id, reason: "Synthetic abuse investigation" }, { idempotencyKey: "suspend", expectedRevision: organization.revision }));
  unwrap(await app.tools.selectIdentity("owner"));
  const resolved = unwrap(await app.services.catalog.resolveScope({ scope: project }));
  expect(resolved.permissions["metadata.read"].allowed).toBe(true);
  expect(resolved.permissions["resources.configure"].allowed).toBe(false);
  expect(resolved.permissions["resources.configure"].reason).toContain("suspension");
});

test("deletion preview names blockers and retained records without performing deletion", async () => {
  const app = await setup(); const preview = unwrap(await app.services.billing.previewDeletion({ scope: org }));
  expect(preview.retained.join(" ")).toContain("audit"); expect(preview.immediatelyRemoved.join(" ")).toContain("Sessions");
  expect(unwrap(await app.services.catalog.resolveScope({ scope: org })).organization.name).toBe("Acme North");
});

test("project archive and organization deletion schedule retain recovery paths and can be reversed", async () => {
  const app = await setup();
  unwrap(await app.services.platform.command({ scope: project }, { kind: "project-archive", archived: true, confirmation: "Notes" }, { idempotencyKey: "archive", expectedRevision: "r1" }));
  let projectScope = unwrap(await app.services.catalog.resolveScope({ scope: project })); expect(projectScope.project?.status).toBe("archived"); expect(projectScope.permissions["data.write"].allowed).toBe(false);
  unwrap(await app.services.platform.command({ scope: project }, { kind: "project-archive", archived: false, confirmation: "Notes" }, { idempotencyKey: "restore", expectedRevision: projectScope.project!.revision }));
  unwrap(await app.services.billing.command({ scope: org }, { kind: "organization.delete.schedule", confirmation: "Acme North" }, { idempotencyKey: "delete", expectedRevision: "r1" }));
  expect(unwrap(await app.services.catalog.resolveScope({ scope: project })).permissions["resources.configure"].allowed).toBe(false);
  const subscription = unwrap(await app.services.billing.getSubscription({ scope: org }));
  unwrap(await app.services.billing.command({ scope: org }, { kind: "organization.delete.cancel" }, { idempotencyKey: "recover", expectedRevision: subscription.revision }));
  expect(unwrap(await app.services.catalog.resolveScope({ scope: project })).permissions["resources.configure"].allowed).toBe(true);
});
