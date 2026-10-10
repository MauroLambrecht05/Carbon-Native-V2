import type { FunctionConfig, FunctionDraft, FunctionSchedule, InvocationIdentity, InvocationInput, Deployment, CloudFunction, Invocation } from "../../../presentation/framework/services/function-contracts";
import type { Json } from "../../../presentation/framework/services/data-contracts";
import type { Permission, Scope } from "../../../presentation/framework/services/contracts";
import { Refusal, requirePermission, requireSession } from "./access";
import { now } from "./clock";
import { configurationState } from "./configuration-state";
import { dataAudit, production, tableFor, timestamp } from "./data-common";
import { policy, tableRows } from "./data-engine";
import { digest } from "./delivery-state";
import { appIdentity, blobAccess } from "./extension-engine";
import { bump, extensions, integer, keyName, sameScope, scoped } from "./extension-state";
import { functions, type StoredInvocation } from "./function-state";
import { allocate } from "./identity-state";
import type { MockState } from "./store";

export const limits = { timeoutMs: 30000, memoryMb: [128, 256, 512], payloadBytes: 16384, concurrency: 4, execution: "Named fixture handlers only; source is never executed. No network, filesystem or platform-admin credentials.", scheduleSyntax: "* * * * *, */N * * * * (N divides 60), or M H * * *. IANA timezone; repeated DST minutes run twice, nonexistent minutes are skipped." };
export const pending = (state: string) => ["queued", "running", "cancel_requested"].includes(state);
export function functionAccess(state: MockState, scope: Scope, permission: Permission, wall: number) {
  const resolved = requirePermission(state, scope, permission, wall);
  binding(state, scope);
  if (permission !== "metadata.read" && permission !== "data.read" && state.extensions?.locks[scope.environmentId!]) throw new Refusal("conflict", "Function writes and execution are paused during restore.");
  return resolved;
}
function binding(state: MockState, scope: Scope) {
  if (!scope.environmentId || !Object.values(state.bindings).some(b => b.owner === "functions" && b.state === "ready" && sameScope(b.scope, scope))) throw new Refusal("unsupported_operation", "Enable and finish provisioning Functions in environment overview.");
  if (state.environments[scope.environmentId]?.status !== "ready" || state.projects[scope.projectId!]?.status === "archived") throw new Refusal("conflict", "This environment must be ready and its project active.");
}
export function validateConfig(state: MockState, scope: Scope, config: FunctionConfig) {
  if (!config || !["echo", "user-error", "infrastructure-error", "timeout", "read-rows", "read-blob"].includes(config.handler) || !["anonymous", "app-session", "service-credential"].includes(config.authorization)) throw new Refusal("validation", "Select a named fixture handler and invocation authorization policy.");
  integer(config.timeoutMs, 100, limits.timeoutMs, "Timeout (ms)"); integer(config.concurrency, 1, limits.concurrency, "Concurrency");
  if (!limits.memoryMb.includes(config.memoryMb)) throw new Refusal("validation", "Memory fixture supports 128, 256 or 512 MB.");
  if (!Array.isArray(config.secrets) || config.secrets.length > 20) throw new Refusal("validation", "Use at most 20 secret references.");
  const names = new Set<string>();
  for (const ref of config.secrets) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(ref.name) || names.has(ref.name)) throw new Refusal("validation", "Secret bindings need distinct uppercase names.");
    names.add(ref.name); scoped(configurationState(state).secrets, scope, ref.secretId);
  }
  if (config.handler === "read-rows") {
    if (config.resource?.kind !== "table") throw new Refusal("validation", "The row fixture requires an explicit same-environment table grant.");
    tableFor(state, scope, config.resource.tableId);
  } else if (config.handler === "read-blob") {
    if (config.resource?.kind !== "blob") throw new Refusal("validation", "The blob fixture requires an explicit same-environment bucket/key grant.");
    scoped(extensions(state).buckets, scope, config.resource.bucketId); keyName(config.resource.key);
  } else if (config.resource) throw new Refusal("validation", "This fixture does not consume resource grants.");
}
export function draft(state: MockState, scope: Scope, source: string, repositoryPath: string, config: FunctionConfig, wall: number, revision = "r1"): FunctionDraft {
  if (typeof source !== "string" || source.length > 64000 || (!source.trim() && !repositoryPath.trim())) throw new Refusal("validation", "Provide source text (up to 64 KB) or a repository-relative path.");
  if (repositoryPath) keyName(repositoryPath);
  validateConfig(state, scope, config);
  return { source, repositoryPath, config: structuredClone(config), revision, savedAt: timestamp(state, wall) };
}
export function deployment(state: MockState, fn: CloudFunction, wall: number, actorId: string, from?: Deployment): Deployment {
  validateConfig(state, fn.scope, fn.draft.config);
  const { source, repositoryPath, config, revision } = fn.draft;
  return { id: allocate(state, "deployment"), scope: fn.scope, functionId: fn.id, source, repositoryPath, config: structuredClone(config), sourceDigest: from?.sourceDigest ?? digest(JSON.stringify([source, repositoryPath])), draftRevision: revision, secretVersions: config.secrets.map(ref => ({ ...ref, version: scoped(configurationState(state).secrets, fn.scope, ref.secretId).version })), createdAt: timestamp(state, wall), actorId, promotedFrom: from?.id };
}
export function compatible(state: MockState, d: Deployment) {
  validateConfig(state, d.scope, d.config);
  for (const ref of d.secretVersions) if (scoped(configurationState(state).secrets, d.scope, ref.secretId).version < ref.version) throw new Refusal("conflict", "A pinned secret version is unavailable.");
}
// Only current drafts, active deployments and pending work prevent secret removal.
// Retained deployments keep immutable IDs/versions, and must pass compatibility before rollback.
export function syncFunctionBindings(state: MockState) {
  const data = functions(state), refs = new Map<string, Set<string>>();
  const add = (id: string, name: string) => { const set = refs.get(id) ?? new Set(); set.add(name); refs.set(id, set); };
  for (const fn of Object.values(data.functions).filter(f => f.status === "enabled")) {
    for (const ref of fn.draft.config.secrets) add(ref.secretId, `function:${fn.id}:draft`);
    for (const ref of data.deployments[fn.activeDeploymentId!]?.secretVersions ?? []) add(ref.secretId, `function:${fn.id}:active`);
  }
  for (const [id, job] of Object.entries(data.jobs)) if (pending(state.operations[id].record.state)) for (const ref of job.deployment.secretVersions) add(ref.secretId, `function:${job.deployment.functionId}:pending`);
  for (const stored of Object.values(data.invocations)) if (pending(stored.record.state)) for (const ref of data.deployments[stored.record.deploymentId]?.secretVersions ?? []) add(ref.secretId, `function:${stored.record.functionId}:invocation`);
  for (const secret of Object.values(configurationState(state).secrets)) {
    const bindings = [...secret.bindings.filter(b => !b.startsWith("function:")), ...refs.get(secret.id) ?? []];
    if (JSON.stringify(bindings) !== JSON.stringify(secret.bindings)) Object.assign(secret, { bindings, revision: bump(secret.revision) });
  }
}
export function serviceCredential(state: MockState, scope: Scope, credentialId: string, wall: number, dataRead = false) {
  const c = scoped(configurationState(state).environmentCredentials, scope, credentialId);
  if (c.audience !== "backend" || !["active", "expiring"].includes(c.status) || Date.parse(c.expiresAt) <= now(state.clock, wall) || (c.overlapEndsAt && Date.parse(c.overlapEndsAt) <= now(state.clock, wall)) || !c.resources.includes("functions") || !c.actions.includes("functions:invoke") || (dataRead && (!c.resources.includes("database") || !c.actions.includes("data:read")))) throw new Refusal("forbidden", "A live backend credential with functions:invoke and any declared data:read grant is required.");
  return c;
}
export function authorizeInvocation(state: MockState, d: Deployment, identity: InvocationIdentity, wall: number, expectedAppSession?: string) {
  if (identity.mode !== d.config.authorization) throw new Refusal("forbidden", "Invocation identity does not satisfy this deployment's authorization policy.");
  if (identity.mode === "app-session") {
    const s = appIdentity(state, d.scope, wall);
    if (expectedAppSession && s.id !== expectedAppSession) throw new Refusal("unauthenticated", "The invoking app session changed or was revoked.");
    return s.id;
  }
  if (identity.mode === "service-credential") serviceCredential(state, d.scope, identity.credentialId, wall, !!d.config.resource);
  return undefined;
}
export function redacted(value: Json, depth = 0): Json {
  if (depth > 10) return "[bounded]";
  if (typeof value === "string") return value.replace(/(?:Bearer\s+|cc_(?:env|org|pat)_)[\w.-]+/gi, "[redacted]").slice(0, 2048);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redacted(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, /secret|password|token|authorization|cookie|api.?key/i.test(k) ? "[redacted]" : redacted(v, depth + 1)]));
  return value;
}
export function safeInput(input: InvocationInput): InvocationInput {
  if (!input || !input.identity || !["anonymous", "app-session", "service-credential"].includes(input.identity.mode) || input.payload === undefined || !input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) throw new Refusal("validation", "Supply JSON payload, headers and a supported identity.");
  if (new TextEncoder().encode(JSON.stringify(input)).length > limits.payloadBytes) throw new Refusal("quota_exceeded", "Invocation exceeds the 16 KB fixture payload limit.");
  if (Object.entries(input.headers).some(([k, v]) => !/^[\w-]{1,64}$/.test(k) || typeof v !== "string" || /[\r\n]/.test(v))) throw new Refusal("validation", "Header names and values are invalid.");
  if (input.businessKey && !/^[\w.-]{1,100}$/.test(input.businessKey)) throw new Refusal("validation", "Business idempotency keys use 1–100 letters, digits, dots, underscores or dashes.");
  return { payload: redacted(input.payload), headers: Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k, ["content-type", "x-request-tag"].includes(k.toLowerCase()) ? String(redacted(v)) : "[redacted]"])), identity: structuredClone(input.identity), businessKey: input.businessKey };
}
export function enqueue(state: MockState, fn: CloudFunction, d: Deployment, input: InvocationInput, wall: number, requestId: string, productionConfirmation: string, sessionId?: string, trigger: Invocation["trigger"] = "http", originalId?: string, scheduleId?: string) {
  binding(state, fn.scope);
  if (fn.status !== "enabled" || state.extensions?.locks[fn.scope.environmentId!]) throw new Refusal("conflict", "Function is disabled or environment execution is paused.");
  compatible(state, d);
  const appSessionId = authorizeInvocation(state, d, input.identity, wall);
  const data = functions(state);
  if (Object.values(data.invocations).filter(i => sameScope(i.record.scope, fn.scope) && pending(i.record.state)).length >= 20) throw new Refusal("quota_exceeded", "The environment's 20-invocation queue is full. Wait or cancel work.");
  const id = allocate(state, "invocation"), time = now(state.clock, wall);
  const actorId = sessionId ? state.sessions[sessionId].accountId : input.identity.mode === "service-credential" ? input.identity.credentialId : "anonymous";
  data.invocations[id] = { record: { id, scope: fn.scope, functionId: fn.id, deploymentId: d.id, actorId, requestId, trigger, originalId, scheduleId, state: "queued", revision: "r1", createdAt: timestamp(state, wall), redacted: true }, input: safeInput(input), sessionId, appSessionId, deadline: time + 1000, production: productionConfirmation };
  dataAudit(state, fn.scope, actorId, "function.invocation.queued", id, requestId, wall);
  return id;
}
export function nextOccurrence(cron: string, timezone: string, after: number): string {
  const match = /^(\*|\*\/(\d+)|(\d+)) (\*|\d+) \* \* \*$/.exec(cron);
  if (!match || (match[2] && (Number(match[2]) < 1 || 60 % Number(match[2]) !== 0)) || (match[3] && Number(match[3]) > 59) || (match[4] !== "*" && Number(match[4]) > 23) || (match[1].startsWith("*") && match[4] !== "*")) throw new Refusal("validation", "Use * * * * *, */N * * * * (N divides 60), or M H * * *.");
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { throw new Refusal("validation", "Use a valid IANA timezone."); }
  for (let t = Math.floor(after / 60000) * 60000 + 60000, i = 0; i < 4320; i++, t += 60000) {
    const parts = format.formatToParts(t), minute = Number(parts.find(p => p.type === "minute")!.value), hour = Number(parts.find(p => p.type === "hour")!.value);
    if ((match[1] === "*" || match[2] && minute % Number(match[2]) === 0 || match[3] && minute === Number(match[3])) && (match[4] === "*" || hour === Number(match[4]))) return new Date(t).toISOString();
  }
  throw new Refusal("validation", "No occurrence found within three days.");
}
function liveActor(state: MockState, sessionId: string, scope: Scope, permission: Permission, wall: number, confirmation: string) {
  const previous = state.activeSessionId;
  try { state.activeSessionId = sessionId; requireSession(state, wall); functionAccess(state, scope, permission, wall); production(state, scope, confirmation, wall); }
  finally { state.activeSessionId = previous; }
}
function result(state: MockState, d: Deployment, stored: StoredInvocation, wall: number): Json {
  const resource = d.config.resource, identity = stored.input.identity;
  if (!resource) return { fixture: "echo", payload: stored.input.payload, headers: stored.input.headers, businessKey: stored.input.businessKey ?? null };
  if (!Object.values(state.bindings).some(b => b.owner === "database" && b.state === "ready" && sameScope(b.scope, d.scope))) throw new Refusal("forbidden", "Database binding is unavailable.");
  const userId = identity.mode === "app-session" ? appIdentity(state, d.scope, wall).userId : undefined;
  if (resource.kind === "table") {
    const table = tableFor(state, d.scope, resource.tableId);
    return { rows: tableRows(state, table).filter(row => identity.mode === "service-credential" || policy(state, table, userId, "select", row.values).allowed).slice(0, 50).map(r => redacted(r.values)) };
  }
  const bucket = scoped(extensions(state).buckets, d.scope, resource.bucketId);
  if (identity.mode !== "service-credential") blobAccess(state, d.scope, bucket, { mode: identity.mode === "anonymous" ? "anonymous" : "app" }, resource.key, wall);
  const blob = Object.values(extensions(state).blobs).find(b => b.bucketId === bucket.id && b.key === resource.key);
  if (!blob) throw new Refusal("not_found", "Fixture blob was not found.");
  const version = blob.versions[0];
  return { key: blob.key, contentType: version.contentType, size: version.size, bytes: version.bytes.slice(0, 256) };
}
export function reconcileFunctions(state: MockState, wall: number): boolean {
  if (!state.functions) return false;
  const data = functions(state), time = now(state.clock, wall); let changed = false;
  for (const [id, job] of Object.entries(data.jobs)) {
    const op = state.operations[id].record;
    if (!pending(op.state) || job.deadline > time) continue;
    const before = `${op.state}:${op.completedSteps}`;
    try {
      liveActor(state, job.sessionId, job.scope, "resources.configure", wall, job.production);
      const fn = scoped(data.functions, job.scope, job.deployment.functionId);
      if (op.state === "cancel_requested") Object.assign(op, { state: "cancelled" });
      else {
        if (fn.revision !== job.functionRevision || fn.status !== "enabled") throw new Refusal("conflict", "Function changed during deployment; previous active deployment is retained.");
        compatible(state, job.deployment);
        if (job.simulateFailure && time >= job.deadline + 1000) throw new Error("Simulated package validation failed; previous deployment remains active.");
        if (time >= job.deadline + 2000) {
          data.deployments[job.deployment.id] = job.deployment;
          Object.assign(fn, { activeDeploymentId: job.deployment.id, revision: bump(fn.revision) });
          Object.assign(op, { state: "succeeded", completedSteps: 3 });
        } else Object.assign(op, { state: "running", completedSteps: time >= job.deadline + 1000 ? 2 : 1 });
      }
    } catch (cause) { Object.assign(op, { state: "failed", error: { code: cause instanceof Refusal ? cause.code : "unavailable", message: cause instanceof Error ? cause.message : "Deployment failed.", requestId: op.requestId } }); }
    const nextRevision = `${op.state}:${op.completedSteps}`;
    if (before !== nextRevision) {
      Object.assign(op, { revision: bump(op.revision), updatedAt: timestamp(state, wall) });
      dataAudit(state, job.scope, op.actorId, `function.deployment.${op.state}`, id, op.requestId, wall, op.state === "failed" ? "failed" : "succeeded"); changed = true;
    }
  }
  for (const stored of Object.values(data.invocations)) {
    const r = stored.record;
    if (!pending(r.state) || stored.deadline > time) continue;
    const d = data.deployments[r.deploymentId];
    try {
      if (stored.sessionId) liveActor(state, stored.sessionId, r.scope, "data.write", wall, stored.production);
      binding(state, r.scope);
      const fn = scoped(data.functions, r.scope, r.functionId);
      if (r.state === "cancel_requested" || fn.status !== "enabled") r.state = "cancelled";
      else {
        if (state.extensions?.locks[r.scope.environmentId!]) throw new Refusal("conflict", "Environment execution paused by restore.");
        compatible(state, d); authorizeInvocation(state, d, stored.input.identity, wall, stored.appSessionId);
        if (r.state === "queued") {
          let start = stored.deadline;
          const intervals = Object.values(data.invocations).filter(i => i.record.functionId === fn.id && i.record.startedAt).map(i => ({ start: Date.parse(i.record.startedAt!), end: i.record.finishedAt ? Date.parse(i.record.finishedAt) : i.deadline }));
          for (;;) {
            const overlaps = intervals.filter(i => i.start <= start && i.end > start);
            if (overlaps.length < d.config.concurrency) break;
            start = Math.min(...overlaps.map(i => i.end));
          }
          if (start > time) continue;
          r.startedAt = new Date(start).toISOString(); r.state = "running";
          stored.deadline = start + (d.config.handler === "timeout" ? d.config.timeoutMs : Math.min(1000, d.config.timeoutMs));
        }
        if (stored.deadline <= time) {
          if (d.config.handler === "timeout") { r.state = "timed_out"; r.failureKind = "timeout"; r.statusCode = 504; }
          else if (["user-error", "infrastructure-error"].includes(d.config.handler)) { r.state = "failed"; r.failureKind = d.config.handler === "user-error" ? "user" : "infrastructure"; r.statusCode = 500; }
          else {
            const output = redacted(result(state, d, stored, wall)), text = JSON.stringify(output);
            r.output = new TextEncoder().encode(text).length > limits.payloadBytes ? { truncated: true, preview: text.slice(0, 2048) } : output;
            r.state = "succeeded"; r.statusCode = 200;
          }
        }
      }
    } catch { r.state = "failed"; r.failureKind = "authorization"; r.statusCode = 403; }
    r.revision = bump(r.revision);
    if (!pending(r.state)) {
      r.finishedAt = new Date(Math.min(time, stored.deadline)).toISOString();
      r.durationMs = r.startedAt ? Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : 0;
      r.logs = [`Named fixture ${d.config.handler}; source was not executed.`, `${r.state}${r.failureKind ? ` (${r.failureKind})` : ""}.`];
      data.usage[r.id] ??= { scope: r.scope, invocationId: r.id, durationMs: r.durationMs, occurredAt: r.finishedAt };
    }
    dataAudit(state, r.scope, r.actorId, `function.invocation.${r.state}`, r.id, r.requestId, wall, ["failed", "timed_out"].includes(r.state) ? "failed" : "succeeded"); changed = true;
  }
  for (const s of Object.values(data.schedules)) {
    if (!s.enabled || Date.parse(s.nextRunAt) > time) continue;
    const due = Date.parse(s.nextRunAt), missed = time - due >= 60000;
    s.nextRunAt = nextOccurrence(s.cron, s.timezone, time); s.lastRunAt = new Date(due).toISOString(); s.revision = bump(s.revision);
    try {
      const fn = scoped(data.functions, s.scope, s.functionId), d = data.deployments[fn.activeDeploymentId!];
      if (!d || fn.status !== "enabled") throw new Refusal("conflict", "Function unavailable.");
      if (missed && s.missed === "skip") s.lastOutcome = "missed";
      else if (s.overlap === "skip" && Object.values(data.invocations).some(i => i.record.functionId === fn.id && pending(i.record.state))) s.lastOutcome = "overlap-skipped";
      else {
        enqueue(state, fn, d, { payload: { scheduledAt: new Date(due).toISOString(), missedOccurrencesCoalesced: missed }, headers: {}, identity: { mode: "service-credential", credentialId: s.credentialId } }, wall, `schedule:${s.id}:${due}`, s.scope.environmentId!, undefined, "schedule", undefined, s.id);
        s.lastOutcome = "queued";
      }
    } catch { s.lastOutcome = "authorization-failed"; }
    dataAudit(state, s.scope, s.credentialId, `function.schedule.${s.lastOutcome}`, s.id, `schedule:${s.id}:${due}`, wall, s.lastOutcome === "authorization-failed" ? "failed" : "succeeded"); changed = true;
  }
  if (changed) syncFunctionBindings(state);
  return changed;
}
