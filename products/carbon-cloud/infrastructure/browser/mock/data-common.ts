import type { CommandOptions, Permission, RequestContext, Result, Scope } from "../../../presentation/framework/services/contracts";
import type { DataTable } from "../../../presentation/framework/services/data-contracts";
import { Refusal, requirePermission, requireSession } from "./access";
import { now } from "./clock";
import { dataState } from "./data-state";
import { allocate } from "./identity-state";
import type { MockState } from "./store";

export type Run = <T>(execute: (state: MockState, requestId: string) => T, config?: { signal?: AbortSignal; mutate?: boolean; fast?: boolean; quiet?: boolean; audit?: { scope: Scope; action: string; resourceId?: string } }) => Promise<Result<T>>;
export const timestamp = (state: MockState, wall: number) => new Date(now(state.clock, wall)).toISOString();
export function checkRevision(actual: string, options: CommandOptions) { if (options.expectedRevision !== actual) throw new Refusal("conflict", "The resource changed. Reload and compare before using the latest revision."); }
export function environmentAccess(state: MockState, context: RequestContext, permission: Permission, wall: number, owner: "database" | "auth" = "database") {
  const resolved = requirePermission(state, context.scope, permission, wall);
  if ((permission === "data.write" || permission === "resources.configure") && state.extensions?.locks[context.scope.environmentId!]) throw new Refusal("conflict", "Environment writes are paused by a restore operation. Inspect its result before retrying.");
  if (!resolved.environment) throw new Refusal("validation", "Select a project environment.");
  if (!resolved.bindings.some(b => b.owner === owner && b.state === "ready")) throw new Refusal("unsupported_operation", `Enable and finish provisioning ${owner} resources in environment overview.`);
  return resolved;
}
export function production(state: MockState, scope: Scope, confirmation: string, wall: number) {
  const resolved = requirePermission(state, scope, "metadata.read", wall);
  if (resolved.environment?.kind === "production" && resolved.environment.requireProductionConfirmation !== false && confirmation !== scope.environmentId) throw new Refusal("validation", `Production target: type ${scope.environmentId} to confirm.`);
}
export function tableFor(state: MockState, scope: Scope, id: string): DataTable {
  const table = dataState(state).tables[id];
  if (!table || table.scope.orgId !== scope.orgId || table.scope.projectId !== scope.projectId || table.scope.environmentId !== scope.environmentId) throw new Refusal("not_found", "Table not found.");
  return table;
}
export function dataAudit(state: MockState, scope: Scope, actorId: string, action: string, resourceId: string, requestId: string, wall: number, outcome: "succeeded" | "failed" = "succeeded") {
  const id = allocate(state, "audit"), occurredAt = timestamp(state, wall);
  state.audits[id] = { id, scope, actorId, action, resourceId, requestId, occurredAt, outcome };
  if (action.includes(".read")) return; // Read auditing must not invalidate the query that produced it.
  const cursor = String(++state.sequence);
  state.events[`event_${cursor}`] = { id: `event_${cursor}`, cursor, scope, resourceId, actorId, action, revision: "r1", occurredAt };
}
export function once<T>(state: MockState, scope: Scope, actor: string, kind: string, payload: unknown, options: CommandOptions, execute: () => T): T {
  if (!options.idempotencyKey?.trim() || options.idempotencyKey.length > 200) throw new Refusal("validation", "A 1–200 character idempotency key is required.");
  const key = JSON.stringify([actor, scope.orgId, scope.projectId, scope.environmentId, kind, options.idempotencyKey]);
  const fingerprint = JSON.stringify([payload, options.expectedRevision]);
  const prior = state.idempotency[key];
  if (prior) { if (prior.fingerprint !== fingerprint) throw new Refusal("conflict", "Idempotency key already used with different input."); return structuredClone(prior.value) as T; }
  const result = execute(); state.idempotency[key] = { fingerprint, value: structuredClone(result) }; return result;
}
export const actor = (state: MockState, wall: number) => requireSession(state, wall).accountId;
export function jsonObject(value: unknown, label = "JSON") { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Refusal("validation", `${label} must be a JSON object.`); if (JSON.stringify(value).length > 100_000) throw new Refusal("validation", `${label} exceeds the 100 KB fixture limit.`); }
