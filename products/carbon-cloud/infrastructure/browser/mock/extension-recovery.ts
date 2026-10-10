import type { BackupSchedule, Coverage, ExtensionCommand, ExtensionJobResult, RestoreInput, Snapshot } from "../../../presentation/framework/services/extension-contracts";
import type { Scope } from "../../../presentation/framework/services/contracts";
import { Refusal, requirePermission, requireSession } from "./access";
import { now } from "./clock";
import { dataAudit, environmentAccess, production, timestamp } from "./data-common";
import { applySchema, parseSql, validateEnvironmentRecords } from "./data-engine";
import { dataState } from "./data-state";
import { digest } from "./delivery-state";
import { allocate } from "./identity-state";
import { bump, coverage, extensions, integer, label, sameScope, schemaRevision, scoped, type ExtensionJob } from "./extension-state";
import { checkJobAuthority, putBlob, mutationRecord, startExtensionJob } from "./extension-engine";
import type { MockState } from "./store";

const excluded = ["App session tokens", "Platform credentials", "Signing private keys", "Secret values", "Function source/config references (Slice 7 unavailable)"];
export function snapshot(state: MockState, scope: Scope, selected: Coverage[]): Snapshot {
  const ext = extensions(state), data = dataState(state);
  const tables = selected.includes("relational") ? Object.values(data.tables).filter(t => sameScope(t.scope, scope)).map(t => selected.includes("policies") ? t : { ...t, rls: true, policies: [] }) : [];
  return structuredClone({ tables, rows: Object.values(data.rows).filter(r => tables.some(t => t.id === r.tableId)), buckets: selected.includes("blobs") ? Object.values(ext.buckets).filter(b => sameScope(b.scope, scope)) : [], blobs: selected.includes("blobs") ? Object.values(ext.blobs).filter(b => sameScope(b.scope, scope)) : [], vectors: selected.includes("vectors") ? Object.values(ext.vectors).filter(b => sameScope(b.scope, scope)) : [], graphs: selected.includes("graph") ? Object.values(ext.graphs).filter(b => sameScope(b.scope, scope)) : [], users: selected.includes("app-users") ? Object.values(data.users).filter(u => u.realmId === `realm_${scope.environmentId}` && u.status !== "deleted").map(u => ({ ...u, sessionCount: 0 })) : [] });
}
export function createBackup(state: MockState, scope: Scope, input: Extract<ExtensionCommand, { kind: "backup.create" }>, wall: number) {
  coverage(input.coverage); integer(input.retentionDays, 1, 90, "Retention days"); label(input.name);
  if (input.coverage.includes("app-users")) environmentAccess(state, { scope }, "data.read", wall, "auth");
  const ext = extensions(state), id = allocate(state, "backup"), snap = snapshot(state, scope, input.coverage);
  ext.snapshots[id] = snap;
  ext.backups[id] = { id, scope, name: input.name, revision: "r1", coverage: input.coverage, schema: schemaRevision(state, scope), createdAt: timestamp(state, wall), protected: input.protected, expiresAt: new Date(now(state.clock, wall) + input.retentionDays * 86400000).toISOString(), consistency: "One local mock transaction at operation commit. No Postgres/S3 transactional consistency or point-in-time recovery guarantee.", omitted: [...excluded, ...["relational", "policies", "blobs", "vectors", "graph", "app-users"].filter(x => !input.coverage.includes(x as Coverage))], counts: { tables: snap.tables.length, rows: snap.rows.length, blobVersions: snap.blobs.reduce((n, b) => n + b.versions.length, 0), vectors: snap.vectors.reduce((n, v) => n + v.points.length, 0), nodes: snap.graphs.reduce((n, g) => n + g.nodes.length, 0), users: snap.users.length } };
  return id;
}
export function nextSchedule(state: MockState, schedule: Pick<BackupSchedule, "timezone" | "hour">, wall: number) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatter.format(0); } catch { throw new Refusal("validation", "Use a valid IANA timezone, for example Europe/Brussels."); }
  integer(schedule.hour, 0, 23, "Local snapshot hour");
  const start = now(state.clock, wall);
  // Minute increments also support half-hour/quarter-hour timezones and DST skips.
  for (let at = Math.floor(start / 60000) * 60000 + 60000; at < start + 49 * 3600000; at += 60000) if (formatter.format(at) === `${String(schedule.hour).padStart(2, "0")}:00`) return new Date(at).toISOString();
  throw new Refusal("validation", "No snapshot time found in the next 49 hours.");
}
function migrationSql(state: MockState, scope: Scope, sql: string, reverse: boolean, wall: number) {
  const drop = /^DROP TABLE ([a-z_][a-z0-9_]*);?$/.exec(sql.trim());
  if (drop && reverse) { const table = Object.values(dataState(state).tables).find(t => sameScope(t.scope, scope) && t.name === drop[1]); if (!table) throw new Refusal("conflict", "Reverse target is absent; determine actual prior outcome before retry."); applySchema(state, scope, { kind: "drop", tableId: table.id, confirmation: table.name }, { idempotencyKey: "migration", expectedRevision: table.revision }, wall); return; }
  const plan = parseSql(sql);
  if (plan.kind !== "create") throw new Refusal("unsupported_operation", "Migration v1 supports CREATE TABLE name (id uuid PRIMARY KEY, title text); reviewed reverse supports DROP TABLE name. Arbitrary SQL is never executed.");
  applySchema(state, scope, { kind: "create", name: plan.tableName, columns: [{ name: "id", type: "uuid", nullable: false, default: { kind: "uuid" } }, { name: "title", type: "text", nullable: true }], primaryKey: "id", rls: true, policies: [] }, { idempotencyKey: "migration" }, wall);
}
export function previewMigration(state: MockState, scope: Scope, id: string, reverse: boolean, wall: number) {
  const ext = extensions(state), migration = scoped(ext.migrations, scope, id), current = schemaRevision(state, scope), expected = reverse ? migration.appliedSchema ?? "unapplied" : migration.base;
  if (reverse && (!migration.reviewed || !migration.reverse.trim() || migration.status !== "applied")) throw new Refusal("unsupported_operation", "Rollback requires an applied migration and an explicitly reviewed reverse. Use a forward corrective migration or restore.");
  const ordered = Object.values(ext.migrations).filter(m => sameScope(m.scope, scope));
  const outOfOrder = reverse ? ordered.some(m => m.order > migration.order && m.status === "applied") : ordered.some(m => m.order < migration.order && m.status !== "applied");
  if (!reverse && migration.status === "applied") return { compatible: false, current, expected, message: "Already applied. Verify recorded outcome; replay is refused." };
  if (current !== expected || outOfOrder) return { compatible: false, current, expected, message: outOfOrder ? "Migration ordering/dependencies differ. Apply predecessors or roll back successors first." : "Schema drift detected. Register a reviewed reconciliation migration against the current schema; no silent repair." };
  const draft = structuredClone(state); migrationSql(draft, scope, reverse ? migration.reverse : migration.forward, reverse, wall);
  return { compatible: true, current, expected, message: "Supported fixture validates against current schema and dependencies. Execution rechecks the base at commit." };
}
export function previewRestore(state: MockState, scope: Scope, input: RestoreInput, wall: number): ExtensionJobResult {
  const ext = extensions(state), backup = scoped(ext.backups, scope, input.backupId); coverage(input.coverage);
  if (input.conflict !== "replace") throw new Refusal("unsupported_operation", "Restore v1 supports explicit replacement of selected resource categories.");
  if (input.coverage.some(c => !backup.coverage.includes(c))) throw new Refusal("validation", "Requested coverage is absent from the snapshot.");
  if (input.failResource && !input.coverage.includes(input.failResource)) throw new Refusal("validation", "Failure fixture must name a selected resource.");
  if (input.targetId) {
    const target = { ...scope, environmentId: input.targetId }; const resolved = requirePermission(state, target, "resources.configure", wall); requirePermission(state, target, "data.write", wall); requirePermission(state, target, "data.read", wall);
    if (resolved.environment?.status !== "ready") throw new Refusal("conflict", "Restore requires a ready target environment.");
    if (ext.locks[input.targetId]) throw new Refusal("conflict", "Another restore already owns this target.");
    if (Object.values(state.operations).some(o => sameScope(o.record.scope, target) && ["queued", "running", "cancel_requested"].includes(o.record.state))) throw new Refusal("conflict", "Finish or cancel active target operations before restore.");
  } else { label(input.newName ?? ""); requirePermission(state, scope, "resources.configure", wall); if (Object.values(state.environments).some(e => e.projectId === scope.projectId && e.name === input.newName)) throw new Refusal("conflict", "New environment name already exists."); }
  return { message: "Replacement preview: writes/jobs pause during apply. App sessions are revoked, never restored. Relational restore without policies is fail-closed. New environments are development environments.", resources: [...input.coverage.map(resource => ({ resource, state: "restored" as const, message: "Will replace this resource category from the manifest." })), ...backup.omitted.map(resource => ({ resource, state: "skipped" as const, message: "Excluded from coverage." }))], targetId: input.targetId };
}
export function prepareRestore(state: MockState, scope: Scope, input: RestoreInput, operationId: string, wall: number) {
  // The caller validates the preview immediately before enqueuing in this transaction.
  // Repeating it here would mistake this very operation for competing target work.
  const ext = extensions(state); let targetId = input.targetId;
  if (targetId) { if (input.confirmation !== `RESTORE ${targetId}`) throw new Refusal("validation", `Type RESTORE ${targetId} to replace selected resources.`); }
  else { targetId = allocate(state, "env"); state.environments[targetId] = { id: targetId, projectId: scope.projectId!, name: input.newName!, kind: "development", status: "ready", revision: "r1" }; const target = { ...scope, environmentId: targetId }; for (const owner of ["database", "auth"] as const) { const id = allocate(state, "binding"); state.bindings[id] = { id, scope: target, owner, serviceResourceId: `mock_${owner}_${targetId}`, state: "ready" }; } dataState(state); }
  ext.locks[targetId] = operationId; ext.jobs[operationId].targetId = targetId;
  return targetId;
}
function restoreCategory(state: MockState, target: Scope, snap: Snapshot, selected: Coverage[], category: Coverage, wall: number) {
  const data = dataState(state), ext = extensions(state), idMap = (id: string) => `restored_${target.environmentId}_${digest(id)}`;
  const userId = (id: string) => {
    const hex = [0, 1, 2, 3].map(salt => digest(JSON.stringify([target.environmentId, id, salt])).split(":")[1].slice(0, 8)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  if (category === "relational") {
    const old = Object.values(data.tables).filter(t => sameScope(t.scope, target)).map(t => t.id);
    for (const row of Object.values(data.rows)) if (old.includes(row.tableId)) delete data.rows[row.id];
    for (const id of old) { delete data.tables[id]; for (const c of Object.values(ext.realtime)) if (c.tableId === id) delete ext.realtime[c.id]; }
    for (const t of snap.tables) { const id = idMap(t.id); data.tables[id] = { ...structuredClone(t), id, scope: target, revision: "r1", rls: selected.includes("policies") ? t.rls : true, policies: selected.includes("policies") ? t.policies : [], constraints: t.constraints.map(c => ({ ...c, targetTableId: c.targetTableId ? idMap(c.targetTableId) : undefined })) }; }
    for (const r of snap.rows) { const id = idMap(r.id); data.rows[id] = { ...structuredClone(r), id, tableId: idMap(r.tableId), revision: "r1" }; }
    validateEnvironmentRecords(state, target);
  } else if (category === "blobs") {
    for (const b of Object.values(ext.buckets).filter(b => sameScope(b.scope, target))) { if (Object.values(ext.blobs).some(o => o.bucketId === b.id && o.versions.some(v => Date.parse(v.createdAt) + b.retentionDays * 86400000 > now(state.clock, wall)))) throw new Refusal("conflict", "Retained target blob versions cannot be overwritten by restore."); delete ext.buckets[b.id]; }
    for (const b of Object.values(ext.blobs)) if (sameScope(b.scope, target)) delete ext.blobs[b.id];
    for (const b of snap.buckets) { const id = idMap(b.id); ext.buckets[id] = { ...structuredClone(b), id, scope: target, revision: "r1" }; }
    for (const b of snap.blobs) { const id = idMap(b.id); ext.blobs[id] = { ...structuredClone(b), id, scope: target, bucketId: idMap(b.bucketId), revision: "r1" }; }
  } else if (category === "vectors") { for (const v of Object.values(ext.vectors)) if (sameScope(v.scope, target)) delete ext.vectors[v.id]; for (const v of snap.vectors) { const id = idMap(v.id); ext.vectors[id] = { ...structuredClone(v), id, scope: target, revision: "r1", index: "none" }; } }
  else if (category === "graph") { for (const g of Object.values(ext.graphs)) if (sameScope(g.scope, target)) delete ext.graphs[g.id]; for (const g of snap.graphs) { const id = idMap(g.id); ext.graphs[id] = { ...structuredClone(g), id, scope: target, revision: "r1" }; } }
  else if (category === "app-users") {
    const realmId = `realm_${target.environmentId}`;
    for (const user of Object.values(data.users)) if (user.realmId === realmId) { user.status = "deleted"; user.profile = {}; user.claims = {}; user.email = ""; }
    for (const u of snap.users) { const id = userId(u.id); data.users[id] = { ...structuredClone(u), id, realmId, revision: "r1", sessionCount: 0 }; }
    // Rewrite owned data references to the new realm identities; old sessions cannot match.
    const map = new Map(snap.users.map(u => [u.id, userId(u.id)]));
    for (const t of Object.values(data.tables).filter(t => sameScope(t.scope, target))) for (const r of Object.values(data.rows).filter(r => r.tableId === t.id)) for (const p of t.policies) if (p.ownerColumn && map.has(String(r.values[p.ownerColumn]))) r.values[p.ownerColumn] = map.get(String(r.values[p.ownerColumn]))!;
    for (const b of Object.values(ext.blobs).filter(b => sameScope(b.scope, target))) if (b.ownerId && map.has(b.ownerId)) { const old = b.ownerId; b.ownerId = map.get(old); b.key = b.key.split(old).join(b.ownerId!); b.name = b.key; }
  }
}
function execute(state: MockState, id: string, wall: number): ExtensionJobResult {
  const ext = extensions(state), job = ext.jobs[id], scope = job.scope; checkJobAuthority(state, job, wall);
  const prior = state.activeSessionId; state.activeSessionId = job.sessionId;
  try {
    if (job.payload.kind === "upload") { const bucket = scoped(ext.buckets, scope, job.payload.bucketId); if (bucket.revision !== job.payload.bucketRevision) throw new Refusal("conflict", "Bucket policy changed during transfer; review and retry."); const blobId = putBlob(state, scope, bucket.id, job.payload.input, wall); return { message: "Binary bytes committed locally.", resources: [{ resource: blobId, state: "succeeded", message: "Transfer complete." }] }; }
    const c = job.payload.command;
    mutationRecord(state, scope, c, { idempotencyKey: id, expectedRevision: job.payload.expectedRevision });
    if (c.kind === "vector.index") { const v = scoped(ext.vectors, scope, c.id); v.index = c.fail ? "failed" : "ready"; v.revision = bump(v.revision); return { message: c.fail ? "Simulated index build failure." : "Simulated exact-scan index ready.", resources: [{ resource: v.id, state: c.fail ? "failed" : "succeeded", message: "Index state is mock metadata; queries always calculate exact scores." }] }; }
    if (c.kind === "backup.create") { const backupId = createBackup(state, scope, c, wall); return { message: "Snapshot committed with explicit coverage manifest.", resources: [{ resource: backupId, state: "succeeded", message: "Recovery point ready." }] }; }
    if (c.kind === "migration.apply") { const m = scoped(ext.migrations, scope, c.id), preview = previewMigration(state, scope, m.id, c.rollback, wall); if (!preview.compatible) throw new Refusal("conflict", preview.message); if (state.environments[scope.environmentId!].kind === "production" && (!m.reviewed || !Object.values(ext.backups).some(b => sameScope(b.scope, scope) && b.coverage.includes("relational") && b.schema === preview.current))) throw new Refusal("conflict", "Review the migration and create a relational backup of the current schema before applying production migrations."); migrationSql(state, scope, c.rollback ? m.reverse : m.forward, c.rollback, wall); m.status = c.rollback ? "rolled-back" : "applied"; m.appliedSchema = schemaRevision(state, scope); m.revision = bump(m.revision); return { message: c.rollback ? "Reviewed reverse committed." : "Migration committed; checksum/order retained.", resources: [{ resource: m.id, state: "succeeded", message: m.appliedSchema }] }; }
    if (c.kind === "backup.restore") {
      const target = { ...scope, environmentId: job.targetId! }; requirePermission(state, target, "resources.configure", wall); requirePermission(state, target, "data.write", wall); requirePermission(state, target, "data.read", wall);
      // Exact RESTORE target confirmation also supplies production intent.
      if (state.environments[target.environmentId!].kind === "production" && c.input.confirmation !== `RESTORE ${target.environmentId}`) throw new Refusal("validation", "Production restore target must be explicitly confirmed.");
      const snap = ext.snapshots[c.input.backupId]; if (!snap) throw new Refusal("not_found", "Snapshot was deleted before restore.");
      const result: ExtensionJobResult = { message: "Restore result by resource. Successful categories remain committed; retry only failed categories.", targetId: target.environmentId, resources: excluded.map(resource => ({ resource, state: "skipped", message: "Not included; old sessions never revived." })) };
      const data = dataState(state); for (const s of Object.values(data.sessions)) if (s.environmentId === target.environmentId) { s.revoked = true; s.revision = bump(s.revision); } delete data.activeSessions[`realm_${target.environmentId}`]; for (const proof of Object.values(data.challenges)) if (proof.realmId === `realm_${target.environmentId}`) proof.consumed = true;
      const ordered: Coverage[] = ["relational", "policies", "blobs", "vectors", "graph", "app-users"];
      for (const category of ordered.filter(cov => c.input.coverage.includes(cov))) {
        const draft = structuredClone(state);
        try { if (category === c.input.failResource) throw new Refusal("conflict", "Simulated partial restore failure."); if (category === "policies" && result.resources.some(r => r.resource === "relational" && r.state === "failed")) throw new Refusal("conflict", "Relational dependency failed."); restoreCategory(draft, target, snap, c.input.failResource === "policies" ? c.input.coverage.filter(v => v !== "policies") : c.input.coverage, category, wall); state.data = draft.data; state.extensions = draft.extensions; result.resources.push({ resource: category, state: "restored", message: category === "policies" ? "Restored with relational schema." : "Selected category replaced." }); } catch (e) { result.resources.push({ resource: category, state: "failed", message: (e as Error).message }); }
      }
      dataAudit(state, target, requireSession(state, wall).accountId, "restore.target.changed", id, state.operations[id].record.requestId, wall);
      return result;
    }
    throw new Refusal("unsupported_operation", "Unsupported extension operation.");
  } finally { state.activeSessionId = prior; }
}
export function reconcileExtensions(state: MockState, wall: number): boolean {
  const initialized = !state.extensions; extensions(state); let changed = initialized;
  for (const id of Object.keys(extensions(state).jobs)) {
    let job = extensions(state).jobs[id]; const record = state.operations[id].record;
    while (job.deadline <= now(state.clock, wall) && ["queued", "running", "cancel_requested"].includes(record.state)) {
      if (record.state === "cancel_requested") { Object.assign(record, { state: "cancelled" }); job.result = { message: "Cancellation acknowledged; no pending resource changes committed. A provisioned restore target remains available.", targetId: job.targetId, resources: [] }; }
      else if (record.state === "queued" || record.completedSteps < 2) { Object.assign(record, { state: "running", completedSteps: record.completedSteps + 1 }); }
      else {
        const draft = structuredClone(state);
        try { const result = execute(draft, id, wall); state.data = draft.data; state.extensions = draft.extensions; state.nextId = draft.nextId; state.events = draft.events; state.audits = draft.audits; state.sequence = draft.sequence; job = extensions(state).jobs[id]; job.result = result; const failed = result.resources.some(r => r.state === "failed"); Object.assign(record, { state: failed ? "failed" : "succeeded", completedSteps: 3, error: failed ? { code: "unavailable", message: "Partial/failure outcome. Inspect per-resource results before retry.", requestId: record.requestId } : undefined }); }
        catch (e) { Object.assign(record, { state: "failed", error: { code: e instanceof Refusal ? e.code : "unavailable", message: (e as Error).message, requestId: record.requestId } }); job.result = { message: (e as Error).message, targetId: job.targetId, resources: [] }; if (job.payload.kind === "command" && job.payload.command.kind === "vector.index") { const v = extensions(state).vectors[job.payload.command.id]; if (v) { v.index = "failed"; v.revision = bump(v.revision); } } }
      }
      Object.assign(record, { revision: bump(record.revision), updatedAt: timestamp(state, wall) }); job.deadline += 1000;
      if (["succeeded", "failed", "cancelled"].includes(record.state)) { if (job.targetId) delete extensions(state).locks[job.targetId]; if (job.payload.kind === "command" && job.payload.command.kind === "vector.index" && record.state === "cancelled") { const v = extensions(state).vectors[job.payload.command.id]; if (v) { v.index = "none"; v.revision = bump(v.revision); } } }
      dataAudit(state, job.scope, record.actorId, `extension.operation.${record.state}`, id, record.requestId, wall, record.state === "failed" ? "failed" : "succeeded"); changed = true;
    }
  }
  for (const schedule of Object.values(extensions(state).schedules)) if (schedule.enabled && Date.parse(schedule.nextAt) <= now(state.clock, wall)) {
    const sessionId = (schedule as BackupSchedule & { sessionId?: string }).sessionId, previous = state.activeSessionId;
    try { state.activeSessionId = sessionId ?? null; environmentAccess(state, { scope: schedule.scope }, "resources.configure", wall); environmentAccess(state, { scope: schedule.scope }, "data.read", wall); if (extensions(state).locks[schedule.scope.environmentId!]) throw new Refusal("conflict", "Restore in progress."); const id = createBackup(state, schedule.scope, { kind: "backup.create", name: `Scheduled ${schedule.nextAt}`, coverage: schedule.coverage, protected: false, retentionDays: schedule.retentionDays }, wall); schedule.lastOutcome = `Created ${id}; missed intervals are coalesced.`; dataAudit(state, schedule.scope, requireSession(state, wall).accountId, "backup.scheduled", id, `schedule:${schedule.id}`, wall); }
    catch (e) { schedule.lastOutcome = `Skipped: ${(e as Error).message}`; }
    finally { state.activeSessionId = previous; }
    schedule.nextAt = nextSchedule(state, schedule, wall); schedule.revision = bump(schedule.revision); changed = true;
  }
  for (const backup of Object.values(extensions(state).backups)) if (!backup.protected && Date.parse(backup.expiresAt) <= now(state.clock, wall) && !Object.entries(extensions(state).jobs).some(([id, j]) => j.payload.kind === "command" && j.payload.command.kind === "backup.restore" && j.payload.command.input.backupId === backup.id && ["queued", "running", "cancel_requested"].includes(state.operations[id].record.state))) { delete extensions(state).backups[backup.id]; delete extensions(state).snapshots[backup.id]; changed = true; }
  return changed;
}
