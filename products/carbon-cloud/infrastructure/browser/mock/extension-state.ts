import type { Backup, BackupSchedule, Bucket, Coverage, ExtensionCommand, ExtensionJobResult, Graph, Migration, RealtimeConfig, RowEvent, Snapshot, StoredBlob, UploadInput, VectorCollection } from "../../../presentation/framework/services/extension-contracts";
import type { DataRow } from "../../../presentation/framework/services/data-contracts";
import type { Scope } from "../../../presentation/framework/services/contracts";
import { Refusal } from "./access";
import { dataState } from "./data-state";
import { timestamp } from "./data-common";
import { digest } from "./delivery-state";
import { allocate } from "./identity-state";
import type { MockState } from "./store";

export type ExtensionJob = { scope: Scope; sessionId: string; deadline: number; production: string; result?: ExtensionJobResult; payload: { kind: "upload"; bucketId: string; bucketRevision: string; input: UploadInput } | { kind: "command"; command: ExtensionCommand; expectedRevision?: string }; targetId?: string; base?: string };
export interface ExtensionState {
  buckets: Record<string, Bucket>; blobs: Record<string, StoredBlob>; vectors: Record<string, VectorCollection>; graphs: Record<string, Graph>;
  realtime: Record<string, RealtimeConfig>; rowEvents: (RowEvent & { scope: Scope })[]; rowSequence: number;
  migrations: Record<string, Migration>; backups: Record<string, Backup>; snapshots: Record<string, Snapshot>; schedules: Record<string, BackupSchedule>;
  jobs: Record<string, ExtensionJob>; locks: Record<string, string>;
  exportAccess?: Record<string, { scope: Scope; backupId: string; sessionId: string; expiresAt: string }>;
  links: Record<string, { scope: Scope; bucketId: string; bucketRevision: string; key: string; objectRevision?: string; mode: "download" | "upload"; expiresAt: string; consumed: boolean; sessionId: string; production: string }>;
}
export function extensions(state: MockState): ExtensionState {
  return state.extensions ??= { buckets: {}, blobs: {}, vectors: {}, graphs: {}, realtime: {}, rowEvents: [], rowSequence: 0, migrations: {}, backups: {}, snapshots: {}, schedules: {}, jobs: {}, locks: {}, links: {} };
}
export const sameScope = (a: Scope, b: Scope) => a.orgId === b.orgId && a.projectId === b.projectId && a.environmentId === b.environmentId;
export function scoped<T extends { scope: Scope }>(records: Record<string, T>, scope: Scope, id: string): T {
  const value = Object.hasOwn(records, id) ? records[id] : undefined;
  if (!value || !sameScope(value.scope, scope)) throw new Refusal("not_found", "Resource not found in this environment.");
  return value;
}
export const bump = (revision: string) => `r${Number(revision.slice(1)) + 1}`;
export function label(value: string) { if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new Refusal("validation", "Use a nonempty name of at most 100 characters."); return value.trim(); }
export function keyName(value: string) { if (typeof value !== "string" || !value || value.length > 500 || value.startsWith("/") || /[\\\x00-\x1f]/.test(value) || value.split("/").some(p => p === ".." || p === ".")) throw new Refusal("validation", "Object keys are opaque, relative keys without dot segments or backslashes. Percent characters are literal, never decoded as paths."); return value; }
export function integer(value: number, min: number, max: number, name: string) { if (!Number.isInteger(value) || value < min || value > max) throw new Refusal("validation", `${name} must be ${min}–${max}.`); }
export function coverage(input: Coverage[]) { if (!Array.isArray(input) || !input.length || new Set(input).size !== input.length || input.some(v => !["relational", "policies", "blobs", "vectors", "graph", "app-users"].includes(v))) throw new Refusal("validation", "Select distinct supported snapshot resources."); if (input.includes("policies") && !input.includes("relational")) throw new Refusal("validation", "Policies require relational schema coverage."); }
export function schemaRevision(state: MockState, scope: Scope) {
  return `schema-${digest(JSON.stringify(Object.values(dataState(state).tables).filter(t => sameScope(t.scope, scope)).sort((a, b) => a.name.localeCompare(b.name)).map(t => ({ name: t.name, columns: t.columns, primaryKey: t.primaryKey, constraints: t.constraints, rls: t.rls, policies: t.policies })))).slice(0, 24)}`;
}
// Capture only committed changes, in the same persistence transaction. No browser code executes SQL.
export function captureRows(state: MockState, before: Record<string, DataRow>, wall: number) {
  const ext = extensions(state), after = dataState(state).rows;
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[id], row = after[id];
    if (JSON.stringify(old) === JSON.stringify(row)) continue;
    const tableId = row?.tableId ?? old.tableId, config = Object.values(ext.realtime).find(c => c.tableId === tableId);
    const kind = !old ? "insert" : !row ? "delete" : "update";
    if (!config?.events.includes(kind)) continue;
    const cursor = String(++ext.rowSequence);
    ext.rowEvents.push({ id: allocate(state, "rowevent"), scope: config.scope, cursor, tableId, rowId: id, revision: row?.revision ?? bump(old.revision), occurredAt: timestamp(state, wall), kind, old: old?.values, row: row?.values });
  }
  ext.rowEvents = ext.rowEvents.slice(-200);
}
