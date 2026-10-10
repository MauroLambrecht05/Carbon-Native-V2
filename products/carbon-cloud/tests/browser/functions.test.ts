import { afterEach, expect, test } from "bun:test";
import { createMockServices, type MockRuntime } from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap, type Result } from "../../presentation/framework/services/contracts";
import type { FunctionConfig, InvocationInput } from "../../presentation/framework/services/function-contracts";
import { nextOccurrence } from "../../infrastructure/browser/mock/function-engine";

const scope = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" }, context = { scope };
const target = { ...scope, environmentId: "env_north_notes_production" }, targetContext = { scope: target };
const foreign = { scope: { orgId: "org_south", projectId: "project_south_notes", environmentId: "env_south_notes_development" } };
const config: FunctionConfig = { handler: "echo", authorization: "anonymous", timeoutMs: 5000, memoryMb: 128, concurrency: 2, secrets: [] };
const input: InvocationInput = { payload: { message: "hello", password: "must-never-persist" }, headers: { authorization: "Bearer sensitive-value", "content-type": "application/json" }, identity: { mode: "anonymous" } };
let runtime: MockRuntime;
const options = (revision?: string) => ({ idempotencyKey: crypto.randomUUID(), expectedRevision: revision });
const code = (result: Result<unknown>) => result.ok ? undefined : result.error.code;
async function setup() {
  const persistence = new MemoryPersistence(seedFoundation(1000)); runtime = createMockServices({ persistence, wallTime: () => 1000, autoTick: false });
  unwrap(await runtime.tools.setLatency(0)); unwrap(await runtime.tools.selectIdentity("owner"));
  unwrap(await runtime.services.platform.command(context, { kind: "provision", services: ["functions", "auth"] }, options("r1"))); await advance(5000);
  return { ...runtime.services, persistence };
}
const advance = async (ms = 4000) => unwrap(await runtime.tools.setClock(true, ms));
async function create(c = config, name = "hello") { return unwrap(await runtime.services.functions.command(context, { kind: "create", name, source: "throw new Error('SOURCE MUST NOT EXECUTE')", repositoryPath: "functions/hello.ts", config: c }, "", options())).resourceId!; }
async function deploy(id: string, fail = false) {
  const { functions: f } = runtime.services, fn = unwrap(await f.get(context, id));
  const receipt = unwrap(await f.command(context, { kind: "deploy", id, simulateFailure: fail }, "", options(fn.revision))); await advance(); return receipt;
}
async function invoke(id: string, value = input) { return unwrap(await runtime.services.functions.invoke(context, id, value, "", options(unwrap(await runtime.services.functions.get(context, id)).revision))).resourceId!; }
async function credential(dataRead = false) { return unwrap(await runtime.services.configuration.credentialCommand(context, { kind: "credential-create", name: "function runner", audience: "backend", resources: dataRead ? ["functions", "database"] : ["functions"], actions: dataRead ? ["functions:invoke", "data:read"] : ["functions:invoke"], expiryDays: 7 }, options())).resourceId!; }
afterEach(() => runtime?.dispose());

test("draft revisions, immutable successful deployments, failed activation, generic controls and reload recovery", async () => {
  const { functions: f, operations, persistence } = await setup(); const id = await create();
  const key = options("r1"); const queued = unwrap(await f.command(context, { kind: "deploy", id, simulateFailure: false }, "", key));
  expect(unwrap(await f.command(context, { kind: "deploy", id, simulateFailure: false }, "", key))).toEqual(queued);
  expect(code(await operations.requestCancel(context, queued.operationId!, options("r1")))).toBe("conflict");
  runtime.dispose(); runtime = createMockServices({ persistence, wallTime: () => 1000, autoTick: false }); await advance();
  expect(unwrap(await runtime.services.operations.get(context, queued.operationId!)).state).toBe("succeeded");
  const fn = unwrap(await runtime.services.functions.get(context, id)), d = unwrap(await runtime.services.functions.deployments(context, id)).items[0];
  expect(d.source).toContain("SOURCE MUST NOT EXECUTE");
  expect(code(await runtime.services.functions.command(context, { kind: "save", id, source: "changed", repositoryPath: "", config }, "", options("r1")))).toBe("conflict");
  unwrap(await runtime.services.functions.command(context, { kind: "save", id, source: "changed", repositoryPath: "", config }, "", options(fn.revision)));
  const failed = await deploy(id, true); expect(unwrap(await runtime.services.operations.get(context, failed.operationId!)).state).toBe("failed");
  expect(unwrap(await runtime.services.functions.get(context, id)).activeDeploymentId).toBe(d.id);
  expect(unwrap(await runtime.services.functions.deployments(context, id)).items[0]).toEqual(d);
  const invoked = await invoke(id); await advance(); expect(unwrap(await runtime.services.functions.invocation(context, id, invoked, true)).state).toBe("succeeded");
});

test("bounded redacted invocations, idempotency, audience/scope gates and content permissions", async () => {
  const { functions: f, persistence } = await setup(); const id = await create(); await deploy(id);
  const key = options(unwrap(await f.get(context, id)).revision), receipt = unwrap(await f.invoke(context, id, input, "", key));
  expect(unwrap(await f.invoke(context, id, input, "", key))).toEqual(receipt);
  expect(code(await f.invoke(context, id, { ...input, payload: "x".repeat(17000) }, "", options(key.expectedRevision)))).toBe("quota_exceeded");
  expect(code(await f.invoke(context, id, { ...input, identity: { mode: "app-session" } }, "", options(key.expectedRevision)))).toBe("forbidden");
  await advance(); const detail = unwrap(await f.invocation(context, id, receipt.resourceId!, true));
  expect(detail.state).toBe("succeeded"); expect(detail.durationMs).toBe(1000); expect(detail.input?.payload).toEqual({ message: "hello", password: "[redacted]" });
  expect(unwrap(await f.invocation(context, id, detail.id, false))).not.toHaveProperty("output");
  unwrap(await runtime.services.platform.command(foreign, { kind: "provision", services: ["functions"] }, options(unwrap(await runtime.services.catalog.resolveScope(foreign)).organization.revision))); await advance(5000); expect(code(await f.get(foreign, id))).toBe("not_found");
  expect(code(await f.invocation(context, id, "missing", true))).toBe("not_found");
  const persisted = await persistence.transact(s => ({ value: JSON.stringify(s.functions), changed: false })); expect(persisted).not.toContain("must-never-persist"); expect(persisted).not.toContain("sensitive-value");
  unwrap(await runtime.tools.selectIdentity("viewer")); expect(unwrap(await f.invocations(context, id)).total).toBe(1); expect(code(await f.invocation(context, id, detail.id, true))).toBe("forbidden"); expect(code(await f.invoke(context, id, input, "", options(key.expectedRevision)))).toBe("forbidden");
  unwrap(await runtime.tools.selectIdentity("app")); expect(code(await f.list(context))).toBe("forbidden");
});

test("invocation error categories, timeout duration, cancellation acknowledgement and retries retain original snapshot", async () => {
  const { functions: f, persistence } = await setup();
  for (const handler of ["user-error", "infrastructure-error", "timeout"] as const) {
    const id = await create({ ...config, handler, timeoutMs: 2000 }, handler); await deploy(id);
    const invocation = await invoke(id); await advance(); const original = unwrap(await f.invocation(context, id, invocation, true));
    expect(original.failureKind).toBe(handler === "user-error" ? "user" : handler === "timeout" ? "timeout" : "infrastructure");
    if (handler === "timeout") expect(original.durationMs).toBe(2000);
    const retry = unwrap(await f.retry(context, id, invocation, "", options(original.revision))).resourceId!;
    const r = unwrap(await f.invocation(context, id, retry, false)); expect(r.originalId).toBe(invocation); expect(r.deploymentId).toBe(original.deploymentId); expect(r.trigger).toBe("retry");
    unwrap(await f.cancel(context, id, retry, "", options(r.revision))); expect(unwrap(await f.invocation(context, id, retry, false)).state).toBe("cancel_requested"); await advance(); expect(unwrap(await f.invocation(context, id, retry, false)).state).toBe("cancelled");
  }
  const before = await persistence.transact(s => ({ value: Object.keys(s.functions!.usage).length, changed: false })); await runtime.tick();
  expect(await persistence.transact(s => ({ value: Object.keys(s.functions!.usage).length, changed: false }))).toBe(before);
});

test("secret bindings block removal, replacement pins a new version only on later deployment, rollback and disable retain history", async () => {
  const { functions: f, configuration: c } = await setup();
  const secretId = unwrap(await c.secretCommand(context, { kind: "secret-create", name: "FUNCTION_KEY", type: "generic", value: "mock-value" }, options())).resourceId!;
  const id = await create({ ...config, secrets: [{ name: "KEY", secretId }] }); await deploy(id);
  let secret = unwrap(await c.listSecrets(context)).items.find(s => s.id === secretId)!;
  expect(secret.bindings.some(b => b.startsWith(`function:${id}`))).toBe(true);
  expect(code(await c.secretCommand(context, { kind: "secret-remove", secretId }, options(secret.revision)))).toBe("conflict");
  unwrap(await c.secretCommand(context, { kind: "secret-replace", secretId, value: "mock-replacement" }, options(secret.revision)));
  const first = unwrap(await f.deployments(context, id)).items[0]; expect(first.secretVersions[0].version).toBe(1);
  await deploy(id); expect(unwrap(await f.deployments(context, id)).items.map(d => d.secretVersions[0].version).sort()).toEqual([1, 2]);
  let fn = unwrap(await f.get(context, id)); unwrap(await f.command(context, { kind: "rollback", id, deploymentId: first.id }, "", options(fn.revision)));
  expect(unwrap(await f.get(context, id)).activeDeploymentId).toBe(first.id);
  fn = unwrap(await f.get(context, id)); unwrap(await f.command(context, { kind: "status", id, status: "disabled", confirmation: fn.name }, "", options(fn.revision)));
  secret = unwrap(await c.listSecrets(context)).items.find(s => s.id === secretId)!; expect(secret.bindings).toEqual([]);
  unwrap(await c.secretCommand(context, { kind: "secret-remove", secretId }, options(secret.revision)));
  expect(unwrap(await f.deployments(context, id)).total).toBe(2); fn = unwrap(await f.get(context, id));
  expect(code(await f.command(context, { kind: "status", id, status: "enabled", confirmation: fn.name }, "", options(fn.revision)))).toBe("not_found");
});

test("app-session row fixtures enforce owner policies and session revocation; service grants are explicit", async () => {
  const { functions: f, data, appAuth, configuration: c } = await setup(); const table = unwrap(await data.listTables(context)).items[0];
  const alice = unwrap(await appAuth.listUsers(context, { email: "alice" })).items[0], realm = `realm_${scope.environmentId}`;
  unwrap(await appAuth.requestChallenge(realm, { email: alice.email, provider: "email", redirect: "http://localhost:3000/callback" }, options())); unwrap(await appAuth.consumeChallenge(realm, unwrap(await appAuth.inbox(context)).items[0].id));
  const id = await create({ ...config, handler: "read-rows", authorization: "app-session", resource: { kind: "table", tableId: table.id } }); await deploy(id);
  const appInput = { ...input, identity: { mode: "app-session" as const } }, invoked = await invoke(id, appInput); await advance();
  const output = unwrap(await f.invocation(context, id, invoked, true)).output as { rows: { owner_id: string }[] }; expect(output.rows).toHaveLength(1); expect(output.rows[0].owner_id).toBe(alice.id);
  const pendingId = await invoke(id, appInput); unwrap(await appAuth.sessionCommand(realm, "signout", {})); await advance(); expect(unwrap(await f.invocation(context, id, pendingId, true)).failureKind).toBe("authorization");
  const serviceId = await create({ ...config, handler: "read-rows", authorization: "service-credential", resource: { kind: "table", tableId: table.id } }, "service-rows"); await deploy(serviceId);
  const narrow = await credential(), wide = await credential(true), fn = unwrap(await f.get(context, serviceId));
  expect(code(await f.invoke(context, serviceId, { ...input, identity: { mode: "service-credential", credentialId: narrow } }, "", options(fn.revision)))).toBe("forbidden");
  const invocation = await invoke(serviceId, { ...input, identity: { mode: "service-credential", credentialId: wide } });
  const cred = unwrap(await c.listEnvironmentCredentials(context)).items.find(c => c.id === wide)!; unwrap(await c.credentialCommand(context, { kind: "credential-revoke", credentialId: wide }, options(cred.revision))); await advance();
  expect(unwrap(await f.invocation(context, serviceId, invocation, true)).failureKind).toBe("authorization");
});

test("schedules preview DST, skip missed occurrences, coalesce once and stop after credential revocation", async () => {
  const { functions: f, configuration: c } = await setup(); const id = await create({ ...config, authorization: "service-credential" }), credentialId = await credential(); await deploy(id);
  const fn = unwrap(await f.get(context, id));
  expect(code(await f.previewSchedule(context, "bad cron", "UTC"))).toBe("validation"); expect(code(await f.previewSchedule(context, "* * * * *", "invalid/zone"))).toBe("validation");
  const saved = unwrap(await f.command(context, { kind: "schedule.save", id, name: "every minute", cron: "* * * * *", timezone: "Europe/Brussels", enabled: true, missed: "skip", overlap: "skip", credentialId }, "", options(fn.revision))).resourceId!;
  await advance(180000); let schedule = unwrap(await f.schedules(context, id)).items[0]; expect(schedule.lastOutcome).toBe("missed"); expect(unwrap(await f.invocations(context, id)).total).toBe(0);
  unwrap(await f.command(context, { kind: "schedule.save", id, scheduleId: saved, name: schedule.name, cron: schedule.cron, timezone: schedule.timezone, enabled: true, missed: "catch-up-once", overlap: "skip", credentialId }, "", options(schedule.revision)));
  await advance(180000); expect(unwrap(await f.invocations(context, id)).total).toBe(1); await runtime.tick(); expect(unwrap(await f.invocations(context, id)).total).toBe(1); await advance();
  const cred = unwrap(await c.listEnvironmentCredentials(context)).items.find(c => c.id === credentialId)!; unwrap(await c.credentialCommand(context, { kind: "credential-revoke", credentialId }, options(cred.revision)));
  await advance(60000); schedule = unwrap(await f.schedules(context, id)).items[0]; expect(schedule.lastOutcome).toBe("authorization-failed");
  expect(nextOccurrence("30 2 * * *", "Europe/Brussels", Date.parse("2026-03-29T00:00:00Z"))).toBe("2026-03-30T00:30:00.000Z");
  expect(nextOccurrence("30 2 * * *", "Europe/Brussels", Date.parse("2026-10-25T00:30:00Z"))).toBe("2026-10-25T01:30:00.000Z");
});

test("promotion reviews target bindings and production scope, preserves digest and fails without touching active source", async () => {
  const { functions: f, platform, operations } = await setup();
  unwrap(await platform.command(targetContext, { kind: "provision", services: ["functions"], confirmation: "production" }, options(unwrap(await runtime.services.catalog.resolveScope(targetContext)).organization.revision))); await advance(5000);
  const id = await create(); await deploy(id); const fn = unwrap(await f.get(context, id)), d = unwrap(await f.deployments(context, id)).items[0];
  const command = { kind: "promote" as const, id, deploymentId: d.id, targetEnvironmentId: target.environmentId, config, reviewed: true };
  expect(code(await f.command(context, { ...command, reviewed: false }, target.environmentId, options(fn.revision)))).toBe("validation");
  expect(code(await f.command(context, command, "", options(fn.revision)))).toBe("validation");
  const receipt = unwrap(await f.command(context, command, target.environmentId, options(fn.revision))); await advance();
  expect(unwrap(await operations.get(targetContext, receipt.operationId!)).state).toBe("succeeded");
  const promoted = unwrap(await f.deployments(targetContext, receipt.resourceId!)).items[0]; expect(promoted.sourceDigest).toBe(d.sourceDigest); expect(promoted.promotedFrom).toBe(d.id); expect(promoted.scope).toEqual(target);
  expect(unwrap(await f.get(context, id)).activeDeploymentId).toBe(d.id);
  unwrap(await runtime.tools.selectIdentity("developer")); expect(code(await f.command(context, { ...command, targetFunctionId: receipt.resourceId, targetRevision: "r2" }, target.environmentId, options(fn.revision)))).toBe("forbidden");
});

test("pending deployment rechecks the initiating membership and concurrent draft revision", async () => {
  const { functions: f, operations } = await setup(); const id = await create();
  const op = unwrap(await f.command(context, { kind: "deploy", id, simulateFailure: false }, "", options("r1")));
  unwrap(await f.command(context, { kind: "save", id, source: "changed during packaging", repositoryPath: "", config }, "", options("r1"))); await advance();
  expect(unwrap(await operations.get(context, op.operationId!)).state).toBe("failed"); expect(unwrap(await f.get(context, id)).activeDeploymentId).toBeUndefined();
  unwrap(await runtime.tools.selectIdentity("developer")); const queued = unwrap(await f.command(context, { kind: "deploy", id, simulateFailure: false }, "", options("r2"))); unwrap(await runtime.tools.revokeMembership(scope)); await advance();
  unwrap(await runtime.tools.selectIdentity("owner")); expect(unwrap(await operations.get(context, queued.operationId!)).state).toBe("failed"); expect(unwrap(await f.get(context, id)).activeDeploymentId).toBeUndefined();
});

test("concurrency excludes queue wait from billing and cancellation/disable never activates pending deployments", async () => {
  const { functions: f, operations } = await setup(); const id = await create({ ...config, concurrency: 1 }); await deploy(id);
  const ids = [await invoke(id), await invoke(id), await invoke(id)]; await advance(1500);
  expect(unwrap(await f.invocation(context, id, ids[0], false)).state).toBe("running");
  expect(unwrap(await f.invocation(context, id, ids[1], false)).state).toBe("queued"); await advance(5000);
  const results = await Promise.all(ids.map(i => f.invocation(context, id, i, false).then(unwrap)));
  expect(results.every(r => r.durationMs === 1000 && r.state === "succeeded")).toBe(true);
  expect(Date.parse(results[1].startedAt!)).toBeGreaterThanOrEqual(Date.parse(results[0].finishedAt!));
  expect(Date.parse(results[2].startedAt!)).toBeGreaterThanOrEqual(Date.parse(results[1].finishedAt!));
  let fn = unwrap(await f.get(context, id)); const active = fn.activeDeploymentId;
  const op = unwrap(await f.command(context, { kind: "deploy", id, simulateFailure: false }, "", options(fn.revision)));
  unwrap(await f.cancelDeployment(context, op.operationId!, "", options("r1"))); await advance(); expect(unwrap(await operations.get(context, op.operationId!)).state).toBe("cancelled");
  expect(unwrap(await f.get(context, id)).activeDeploymentId).toBe(active);
  const queued = await invoke(id); fn = unwrap(await f.get(context, id)); unwrap(await f.command(context, { kind: "status", id, status: "deleted", confirmation: fn.name }, "", options(fn.revision))); await advance();
  expect(unwrap(await f.invocation(context, id, queued, false)).state).toBe("cancelled"); expect(code(await f.invoke(context, id, input, "", options(unwrap(await f.get(context, id)).revision)))).toBe("conflict");
  expect(unwrap(await f.deployments(context, id)).total).toBe(1);
});

test("read-blob fixtures apply private bucket policy and retain bounded binary bytes", async () => {
  const { functions: f, extensions: ext } = await setup();
  const bucketId = unwrap(await ext.command(context, { kind: "bucket.save", name: "private", public: false, publicConfirmation: "", mimeTypes: [], maxBytes: 2000000, retentionDays: 0, versioning: false, userUploads: false, anonymousUploads: false, userPrefix: "users/{userId}/" }, "", options())).resourceId!;
  unwrap(await ext.upload(context, bucketId, { key: "fixture.bin", bytes: [0, 255, 128], contentType: "application/octet-stream", conflict: "error", access: { mode: "dashboard" } }, "", options())); await advance();
  const id = await create({ ...config, handler: "read-blob", resource: { kind: "blob", bucketId, key: "fixture.bin" } }); await deploy(id); const denied = await invoke(id); await advance(); expect(unwrap(await f.invocation(context, id, denied, true)).statusCode).toBe(403);
  const credentialId = await credential(true), serviceId = await create({ ...config, handler: "read-blob", authorization: "service-credential", resource: { kind: "blob", bucketId, key: "fixture.bin" } }, "blob-service"); await deploy(serviceId);
  const result = await invoke(serviceId, { ...input, identity: { mode: "service-credential", credentialId } }); await advance(); expect(unwrap(await f.invocation(context, serviceId, result, true)).output).toEqual({ key: "fixture.bin", contentType: "application/octet-stream", size: 3, bytes: [0, 255, 128] });
});

test("schedule overlap is recorded, schedule credentials outlive the dashboard session and reset clears function state", async () => {
  const { functions: f, session, persistence } = await setup(); const id = await create({ ...config, authorization: "service-credential", handler: "timeout", timeoutMs: 30000 }), credentialId = await credential(); await deploy(id);
  unwrap(await f.command(context, { kind: "schedule.save", id, name: "every minute", cron: "* * * * *", timezone: "UTC", enabled: true, missed: "catch-up-once", overlap: "skip", credentialId }, "", options(unwrap(await f.get(context, id)).revision)));
  const schedule = unwrap(await f.schedules(context, id)).items[0], time = Date.parse(unwrap(await runtime.tools.inspect()).now);
  await advance(Date.parse(schedule.nextRunAt) - time - 1000); await invoke(id, { ...input, identity: { mode: "service-credential", credentialId } }); await advance(1000);
  expect(unwrap(await f.schedules(context, id)).items[0].lastOutcome).toBe("overlap-skipped"); await advance(31000);
  unwrap(await session.signOut()); await advance(60000);
  unwrap(await runtime.tools.selectIdentity("owner")); expect(unwrap(await f.invocations(context, id, { trigger: "schedule" })).total).toBe(1);
  unwrap(await runtime.tools.reset("RESET MOCK")); expect(await persistence.transact(s => ({ value: s.functions, changed: false }))).toBeUndefined();
});
