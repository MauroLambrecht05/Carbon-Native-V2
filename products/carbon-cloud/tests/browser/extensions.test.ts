import { afterEach, expect, test } from "bun:test";
import { createMockServices, type MockRuntime } from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap, type Result } from "../../presentation/framework/services/contracts";
import type { ExtensionCommand, RealtimeMessage } from "../../presentation/framework/services/extension-contracts";

const scope = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" }, context = { scope };
const foreign = { scope: { orgId: "org_south", projectId: "project_south_notes", environmentId: "env_south_notes_development" } };
let runtime: MockRuntime;
const options = (revision?: string) => ({ idempotencyKey: crypto.randomUUID(), expectedRevision: revision });
const code = (result: Result<unknown>) => result.ok ? undefined : result.error.code;
async function setup() { const persistence = new MemoryPersistence(seedFoundation(1000)); runtime = createMockServices({ persistence, wallTime: () => 1000, autoTick: false }); unwrap(await runtime.tools.setLatency(0)); unwrap(await runtime.tools.selectIdentity("owner")); unwrap(await runtime.tools.setClock(true, 0)); return { ...runtime.services, persistence }; }
const advance = async (ms = 4000) => unwrap(await runtime.tools.setClock(true, ms));
const bucketCommand = (name = "private-files"): ExtensionCommand => ({ kind: "bucket.save", name, public: false, publicConfirmation: "", mimeTypes: [], maxBytes: 2000000, retentionDays: 0, versioning: true, userUploads: true, anonymousUploads: false, userPrefix: "users/{userId}/" });
async function jobDone(id: string) { await advance(); expect(unwrap(await runtime.services.operations.get(context, id)).state).toBe("succeeded"); }
afterEach(() => runtime?.dispose());

test("binary transfers persist exact bytes, enforce private policies, revision conflicts, cancellation and expiring scope-bound links", async () => {
  const { extensions: ext, persistence } = await setup();
  const bucketId = unwrap(await ext.command(context, bucketCommand(), "", options())).resourceId!;
  const input = { key: "nested/file%2Fname.bin", bytes: [0, 255, 128, 60, 62], contentType: "application/octet-stream", conflict: "error" as const, access: { mode: "dashboard" as const } };
  const receipt = unwrap(await ext.upload(context, bucketId, input, "", options())); await jobDone(receipt.operationId!);
  const blob = unwrap(await ext.objects(context, bucketId)).items[0]; expect(blob.versions[0].size).toBe(5); expect("bytes" in blob.versions[0]).toBe(false);
  expect(unwrap(await ext.download(context, blob.id, { mode: "dashboard" })).bytes).toEqual(input.bytes);
  expect(code(await ext.download(context, blob.id, { mode: "anonymous" }))).toBe("forbidden");
  expect(code(await ext.download(foreign, blob.id, { mode: "dashboard" }))).toBe("not_found");
  const token = unwrap(await ext.createLink(context, bucketId, input.key, "download", 1, "", options())).resourceId!;
  expect(unwrap(await ext.useLink(context, token))).toHaveProperty("bytes", input.bytes); await advance(1001); expect(code(await ext.useLink(context, token))).toBe("forbidden");
  expect(code(await ext.upload(context, bucketId, { ...input, conflict: "replace", objectRevision: "r999" }, "", options()))).toBe("conflict");
  const replacement = unwrap(await ext.upload(context, bucketId, { ...input, bytes: [17, 19], conflict: "replace", objectRevision: blob.revision }, "", options())); await jobDone(replacement.operationId!);
  const replaced = unwrap(await ext.objects(context, bucketId)).items[0]; expect(replaced.versions.length).toBe(2);
  unwrap(await ext.command(context, { kind: "blob.restore", id: blob.id, versionId: blob.versions[0].id }, "", options(replaced.revision))); expect(unwrap(await ext.download(context, blob.id, { mode: "dashboard" })).bytes).toEqual(input.bytes);
  const pending = unwrap(await ext.upload(context, bucketId, { ...input, key: "cancel.bin" }, "", options())); unwrap(await ext.cancel(context, pending.operationId!, options("r1"))); await advance(); expect(unwrap(await runtime.services.operations.get(context, pending.operationId!)).state).toBe("cancelled"); expect(unwrap(await ext.objects(context, bucketId)).total).toBe(1);
  expect(code(await ext.upload(context, bucketId, { ...input, key: "../escape" }, "", options()))).toBe("validation");
  runtime.dispose(); runtime = createMockServices({ persistence, wallTime: () => 1000, autoTick: false }); expect(unwrap(await runtime.services.extensions.download(context, blob.id, { mode: "dashboard" })).bytes).toEqual(input.bytes);
});

test("vector scoring and graph paths are deterministic, validated, dependency-aware and permission scoped", async () => {
  const { extensions: ext } = await setup();
  const id = unwrap(await ext.command(context, { kind: "vector.create", name: "points", dimensions: 2, metric: "euclidean" }, "", options())).resourceId!;
  const receipt = unwrap(await ext.command(context, { kind: "vector.upsert", id, points: [{ id: "a", vector: [0, 0], metadata: { group: "x" } }, { id: "b", vector: [3, 4], metadata: { group: "x" } }, { id: "bad", vector: [NaN], metadata: {} }] }, "", options("r1"))); expect(receipt.message).toContain("2 points saved, 1 rejected");
  const found = unwrap(await ext.vectorSearch(context, id, [0, 0], 5, { group: "x" })); expect(found.hits.map(h => [h.id, h.score])).toEqual([["a", 0], ["b", 5]]);
  expect(code(await ext.vectorSearch(context, id, [1], 5, {}))).toBe("validation");
  const graphId = unwrap(await ext.command(context, { kind: "graph.create", name: "routes" }, "", options())).resourceId!;
  const nodes = ["a", "b", "c", "d"].map(id => ({ id, label: id, properties: {} }));
  const edge = (id: string, source: string, target: string, weight: number) => ({ id, source, target, weight, relationship: "next", properties: {} });
  expect(code(await ext.command(context, { kind: "graph.import", id: graphId, nodes, edges: [edge("bad", "a", "missing", 1)], preview: false }, "", options("r1")))).toBe("validation"); expect(unwrap(await ext.graphRecords(context, graphId, "nodes")).total).toBe(0);
  unwrap(await ext.command(context, { kind: "graph.import", id: graphId, nodes, edges: [edge("ab", "a", "b", 1), edge("bc", "b", "c", 2), edge("ac", "a", "c", 8)], preview: false }, "", options("r1")));
  expect(unwrap(await ext.graphPath(context, graphId, "a", "c"))).toEqual({ found: true, nodes: ["a", "b", "c"], edges: ["ab", "bc"], cost: 3 }); expect(unwrap(await ext.graphPath(context, graphId, "a", "d")).found).toBe(false);
  expect(code(await ext.command(context, { kind: "graph.delete", id: graphId, nodeId: "b", confirmation: "b", cascade: false }, "", options("r2")))).toBe("conflict");
  unwrap(await runtime.tools.selectIdentity("developer")); expect(code(await ext.graphPath(context, graphId, "a", "c"))).toBe("forbidden"); expect(code(await ext.vectorPoints(context, id))).toBe("forbidden"); expect(unwrap(await ext.list(context, "vectors")).items[0]).not.toHaveProperty("points");
});

test("migration drift, order, immutable checksums, operation cancellation and reviewed rollback", async () => {
  const { extensions: ext, data } = await setup();
  const base = unwrap(await ext.schemaStatus(context)).revision;
  const m = unwrap(await ext.command(context, { kind: "migration.register", name: "tasks", order: 1, forward: "CREATE TABLE tasks (id uuid PRIMARY KEY, title text);", reverse: "DROP TABLE tasks;", reviewed: true, base }, "", options())).resourceId!;
  expect(unwrap(await ext.previewMigration(context, m, false)).compatible).toBe(true);
  const op = unwrap(await ext.command(context, { kind: "migration.apply", id: m, rollback: false }, "", options("r1"))); await jobDone(op.operationId!);
  expect(unwrap(await data.listTables(context)).items.some(t => t.name === "tasks")).toBe(true);
  expect(unwrap(await ext.schemaStatus(context)).drift).toBe(false);
  expect(code(await ext.command(context, { kind: "migration.register", name: "tampered", order: 1, forward: "CREATE TABLE changed (id uuid PRIMARY KEY, title text);", reverse: "", reviewed: false, base }, "", options()))).toBe("conflict");
  const applied = unwrap(await ext.list(context, "migrations")).items[0];
  expect(code(await ext.command(context, { kind: "migration.apply", id: m, rollback: false }, "", options(applied.revision)))).toBe("conflict");
  const rollback = unwrap(await ext.command(context, { kind: "migration.apply", id: m, rollback: true }, "", options(applied.revision))); await jobDone(rollback.operationId!); expect(unwrap(await data.listTables(context)).items.some(t => t.name === "tasks")).toBe(false);
  const next = unwrap(await ext.schemaStatus(context)).revision;
  const drift = unwrap(await ext.command(context, { kind: "migration.register", name: "after", order: 2, forward: "CREATE TABLE later (id uuid PRIMARY KEY, title text);", reverse: "", reviewed: false, base: next }, "", options())).resourceId!;
  expect(unwrap(await ext.previewMigration(context, drift, false)).compatible).toBe(false);
});

test("backup manifests exclude sessions/secrets, exports expire, restore locks writes and reports partial failure without losing successful categories", async () => {
  const { extensions: ext, data } = await setup();
  unwrap(await runtime.services.platform.command(context, { kind: "provision", services: ["auth"] }, options("r1"))); await advance(5000);
  const snapshot = unwrap(await ext.command(context, { kind: "backup.create", name: "recovery", coverage: ["relational", "policies", "vectors", "app-users"], protected: true, retentionDays: 7 }, "", options())); await jobDone(snapshot.operationId!);
  const backup = unwrap(await ext.list(context, "backups")).items[0]; expect(backup.omitted).toContain("App session tokens");
  const lease = unwrap(await ext.backupExportAccess(context, backup.id)); const download = unwrap(await ext.backupDownload(context, backup.id, lease.token)); expect(JSON.parse(download.text).fixture).not.toHaveProperty("sessions"); await advance(60001); expect(code(await ext.backupDownload(context, backup.id, lease.token))).toBe("forbidden");
  const command: ExtensionCommand = { kind: "backup.restore", input: { backupId: backup.id, newName: "restored", coverage: ["relational", "policies", "vectors", "app-users"], conflict: "replace", confirmation: "", failResource: "vectors" } };
  const restored = unwrap(await ext.command(context, command, "", options())); await advance(); expect(unwrap(await runtime.services.operations.get(context, restored.operationId!)).state).toBe("failed");
  const result = unwrap(await ext.jobResult(context, restored.operationId!)); expect(result.resources.find(r => r.resource === "relational")?.state).toBe("restored"); expect(result.resources.find(r => r.resource === "vectors")?.state).toBe("failed");
  const target = { scope: { ...scope, environmentId: result.targetId } }; expect(unwrap(await data.listTables(target)).total).toBe(1);
  const same = { kind: "backup.restore" as const, input: { backupId: backup.id, targetId: scope.environmentId, coverage: ["relational" as const, "policies" as const], conflict: "replace" as const, confirmation: `RESTORE ${scope.environmentId}` } }, key = options();
  const locked = unwrap(await ext.command(context, same, "", key)); expect(unwrap(await ext.command(context, same, "", key)).operationId).toBe(locked.operationId);
  const table = unwrap(await data.listTables(context)).items[0]; expect(code(await data.rowCommand(context, table.id, { kind: "insert", values: { owner_id: "x", title: "blocked" } }, { mode: "administrative" }, "", options()))).toBe("conflict");
  unwrap(await ext.cancel(context, locked.operationId!, options("r1"))); await advance(); expect(unwrap(await runtime.services.operations.get(context, locked.operationId!)).state).toBe("cancelled");
  expect(code(await ext.command(context, { kind: "backup.delete", id: backup.id, confirmation: backup.name }, "", options(backup.revision)))).toBe("conflict");
});

test("realtime delivers committed owner rows with cursors and closes on app revocation", async () => {
  const { extensions: ext, data, appAuth } = await setup();
  unwrap(await runtime.services.platform.command(context, { kind: "provision", services: ["auth"] }, options("r1"))); await advance(5000);
  const table = unwrap(await data.listTables(context)).items[0], realmId = `realm_${scope.environmentId}`;
  unwrap(await ext.command(context, { kind: "realtime.save", tableId: table.id, events: ["insert", "update", "delete"] }, "", options()));
  unwrap(await appAuth.requestChallenge(realmId, { email: "alice@example.test", provider: "email", redirect: "http://localhost:3000/callback" }, options())); const proof = unwrap(await appAuth.inbox(context)).items[0].id; unwrap(await appAuth.consumeChallenge(realmId, proof));
  const session = unwrap(await appAuth.currentSession(realmId))!, messages: RealtimeMessage[] = [];
  const close = unwrap(await ext.subscribe(context, table.id, undefined, m => messages.push(m)));
  unwrap(await appAuth.rowCommand(realmId, table.id, { kind: "insert", values: { owner_id: session.user.id, title: "allowed" } }, options()));
  for (let i = 0; i < 8; i++) await runtime.tick();
  expect(messages.some(m => m.events.some(e => e.row?.title === "allowed"))).toBe(true);
  unwrap(await data.rowCommand(context, table.id, { kind: "insert", values: { owner_id: "10000000-0000-4000-8000-000000000001", title: "bob private" } }, { mode: "administrative" }, "", options()));
  for (let i = 0; i < 8; i++) await runtime.tick(); expect(messages.some(m => m.events.some(e => e.row?.title === "bob private"))).toBe(false);
  unwrap(await appAuth.sessionCommand(realmId, "signout")); for (let i = 0; i < 8; i++) await runtime.tick(); expect(messages.at(-1)?.state).toBe("closed"); close();
});

test("scheduled snapshots respect timezone and retained recovery points; queued transfers recheck expired authority", async () => {
  const { extensions: ext, session } = await setup();
  await advance(1000); unwrap(await runtime.tools.selectIdentity("owner"));
  const now = Date.parse(unwrap(await runtime.tools.inspect()).now), nextHour = (new Date(now).getUTCHours() + 1) % 24;
  unwrap(await ext.command(context, { kind: "backup.schedule", enabled: true, timezone: "UTC", hour: nextHour, retentionDays: 1, coverage: ["relational"] }, "", options()));
  const schedule = unwrap(await ext.list(context, "schedules")).items[0]; await advance(Date.parse(schedule.nextAt) - now + 1);
  expect(unwrap(await ext.list(context, "backups")).total).toBe(1);
  const bucket = unwrap(await ext.command(context, bucketCommand("expired-authority"), "", options())).resourceId!;
  const upload = unwrap(await ext.upload(context, bucket, { key: "never-committed", bytes: [1], contentType: "application/octet-stream", conflict: "error", access: { mode: "dashboard" } }, "", options()));
  unwrap(await session.signOut()); await advance(); unwrap(await runtime.tools.selectIdentity("owner"));
  expect(unwrap(await runtime.services.operations.get(context, upload.operationId!)).state).toBe("failed"); expect(unwrap(await ext.objects(context, bucket)).total).toBe(0);
});
