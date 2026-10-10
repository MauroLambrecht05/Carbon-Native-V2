import type { BlobAccess, Bucket, ExtensionCommand, ExtensionJobResult, Graph, ObjectVersion, UploadInput, VectorCollection } from "../../../presentation/framework/services/extension-contracts";
import type { CommandOptions, Scope } from "../../../presentation/framework/services/contracts";
import { Refusal, requireSession } from "./access";
import { now } from "./clock";
import { checkRevision, dataAudit, environmentAccess, jsonObject, production, timestamp } from "./data-common";
import { dataState } from "./data-state";
import { digest } from "./delivery-state";
import { allocate } from "./identity-state";
import { bump, extensions, integer, keyName, label, sameScope, scoped, type ExtensionJob } from "./extension-state";
import type { MockState } from "./store";

export function appIdentity(state: MockState, scope: Scope, wall: number) {
  if (!Object.values(state.bindings).some(b => b.owner === "auth" && b.state === "ready" && sameScope(b.scope, scope))) throw new Refusal("unsupported_operation", "Enable Auth in this environment before using app-identity access.");
  const data = dataState(state), realmId = `realm_${scope.environmentId}`, session = data.sessions[data.activeSessions[realmId]];
  const user = session && data.users[session.userId];
  if (!session || session.revoked || session.audience !== "app" || session.realmId !== realmId || Date.parse(session.expiresAt) <= now(state.clock, wall) || !user || user.status !== "active" || !user.verified) throw new Refusal("unauthenticated", "Sign in to an active verified app identity in this environment. The inspector never impersonates a user ID.");
  return session;
}
export function blobAccess(state: MockState, scope: Scope, bucket: Bucket, access: BlobAccess, key: string, wall: number, write = false) {
  if (access.mode === "dashboard") { environmentAccess(state, { scope }, write ? "data.write" : "data.read", wall); return undefined; }
  if (access.mode === "anonymous") { if (!(write ? bucket.anonymousUploads : bucket.public)) throw new Refusal("forbidden", "Private access denied; anonymous uploads require an explicit bucket policy."); return undefined; }
  if (access.mode !== "app") throw new Refusal("validation", "Unknown storage access mode.");
  const session = appIdentity(state, scope, wall), prefix = bucket.userPrefix.replace("{userId}", session.userId);
  if (!(write ? bucket.userUploads && key.startsWith(prefix) : bucket.public || key.startsWith(prefix))) throw new Refusal("forbidden", "The app policy permits only this user's configured key prefix.");
  return session.userId;
}
export function bytesVersion(state: MockState, bucket: Bucket, input: { bytes: number[]; contentType: string }, wall: number): ObjectVersion {
  if (!Array.isArray(input.bytes) || input.bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Refusal("validation", "Upload needs binary byte values from 0 to 255.");
  if (input.bytes.length > bucket.maxBytes) throw new Refusal("quota_exceeded", "File exceeds bucket size limit.");
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(input.contentType) || bucket.mimeTypes.length && !bucket.mimeTypes.includes(input.contentType)) throw new Refusal("validation", "Content type is not allowed by this bucket.");
  const usage = Object.values(extensions(state).blobs).filter(b => sameScope(b.scope, bucket.scope)).reduce((n, b) => n + b.versions.reduce((s, v) => s + v.size, 0), 0);
  if (usage + input.bytes.length > 10_000_000) throw new Refusal("quota_exceeded", "The environment's 10 MB local blob quota is exhausted (all retained versions count).");
  return { id: allocate(state, "version"), bytes: [...input.bytes], contentType: input.contentType, size: input.bytes.length, digest: `mock-etag:${digest(JSON.stringify(input.bytes))}`, createdAt: timestamp(state, wall) };
}
export function putBlob(state: MockState, scope: Scope, bucketId: string, input: UploadInput, wall: number) {
  const ext = extensions(state), bucket = scoped(ext.buckets, scope, bucketId), key = keyName(input.key);
  const ownerId = blobAccess(state, scope, bucket, input.access, key, wall, true);
  if (!["error", "replace"].includes(input.conflict)) throw new Refusal("validation", "Choose error or replace for conflicts.");
  const old = Object.values(ext.blobs).find(b => b.bucketId === bucketId && b.key === key);
  if (old) { if (input.conflict === "error") throw new Refusal("conflict", "Object already exists. Review its revision to replace."); checkRevision(old.revision, { idempotencyKey: "upload", expectedRevision: input.objectRevision }); }
  if (input.fail) throw new Refusal("conflict", "Simulated transfer failure. Source and existing version retained; retry explicitly.");
  const version = bytesVersion(state, bucket, input, wall), id = old?.id ?? allocate(state, "blob");
  ext.blobs[id] = { id, scope, name: key, key, bucketId, ownerId: old?.ownerId ?? ownerId, revision: old ? bump(old.revision) : "r1", versions: [version, ...(bucket.versioning || bucket.retentionDays ? old?.versions ?? [] : [])] };
  return id;
}
export function retained(bucket: Bucket, versions: ObjectVersion[], state: MockState, wall: number) {
  if (versions.some(v => Date.parse(v.createdAt) + bucket.retentionDays * 86400000 > now(state.clock, wall))) throw new Refusal("conflict", "Object versions are protected by bucket retention. No source bytes were deleted.");
}
export function vector(value: number[], dimensions: number, metric: string) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(n => !Number.isFinite(n) || Math.abs(n) > 1e100)) throw new Refusal("validation", `Expected exactly ${dimensions} finite vector components (absolute value <= 1e100).`);
  if (metric === "cosine" && !value.some(n => n !== 0)) throw new Refusal("validation", "Cosine distance is undefined for a zero vector.");
}
export function graphImport(graph: Graph, command: Extract<ExtensionCommand, { kind: "graph.import" }>) {
  if (!Array.isArray(command.nodes) || !Array.isArray(command.edges) || command.nodes.length + command.edges.length > 1000) throw new Refusal("validation", "Graph imports accept at most 1,000 items.");
  const errors: string[] = [], draft = structuredClone(graph), ids = new Set<string>();
  command.nodes.forEach((node, i) => { try { label(node.id); label(node.label); jsonObject(node.properties); if (ids.has(node.id)) throw new Refusal("validation", "Duplicate input node ID."); ids.add(node.id); const old = draft.nodes.find(n => n.id === node.id); const next = { ...node, revision: old ? bump(old.revision) : "r1" }; draft.nodes = [...draft.nodes.filter(n => n.id !== node.id), next]; } catch (e) { errors.push(`Node ${i + 1}: ${(e as Error).message}`); } });
  ids.clear();
  command.edges.forEach((edge, i) => { try { label(edge.id); label(edge.relationship); jsonObject(edge.properties); if (ids.has(edge.id)) throw new Refusal("validation", "Duplicate input edge ID."); ids.add(edge.id); if (!draft.nodes.some(n => n.id === edge.source) || !draft.nodes.some(n => n.id === edge.target)) throw new Refusal("validation", "Both endpoints must exist in this graph."); if (!Number.isFinite(edge.weight) || edge.weight < 0 || edge.weight > 1e100) throw new Refusal("validation", "Dijkstra weights must be finite, nonnegative, and <= 1e100."); const old = draft.edges.find(e => e.id === edge.id); draft.edges = [...draft.edges.filter(e => e.id !== edge.id), { ...edge, revision: old ? bump(old.revision) : "r1" }]; } catch (e) { errors.push(`Edge ${i + 1}: ${(e as Error).message}`); } });
  if (!command.preview) { if (errors.length) throw new Refusal("validation", errors.join("\n")); Object.assign(graph, draft, { revision: bump(graph.revision) }); }
  return `${command.preview ? "Preview" : "Committed"}: ${command.nodes.length} nodes, ${command.edges.length} edges. ${errors.length ? errors.join("\n") : "All endpoints resolved."}`;
}
export function startExtensionJob(state: MockState, scope: Scope, job: Omit<ExtensionJob, "scope" | "sessionId" | "deadline">, requestId: string, wall: number) {
  const id = allocate(state, "extension_job"), session = requireSession(state, wall);
  extensions(state).jobs[id] = { ...job, scope, sessionId: session.id, deadline: now(state.clock, wall) + 1000 };
  state.operations[id] = { deadline: Number.MAX_SAFE_INTEGER, failStep: null, record: { id, scope, actorId: session.accountId, kind: "data.extension", state: "queued", completedSteps: 0, totalSteps: 3, steps: ["Validate current authority and revisions", "Transfer or apply fixture", "Commit and report resource outcomes"], revision: "r1", createdAt: timestamp(state, wall), updatedAt: timestamp(state, wall), requestId, actions: { cancel: { allowed: false, reason: "Use the data extension operation cancellation control." }, retry: { allowed: false, reason: "Review actual result and submit a new operation; completed resources are never replayed automatically." } } } };
  return id;
}
export function extensionPermission(command: ExtensionCommand): "resources.configure" | "data.write" {
  return command.kind.startsWith("blob.") || command.kind === "vector.upsert" || command.kind === "vector.delete" && !!command.pointId || command.kind === "graph.import" || command.kind === "graph.delete" && !!(command.nodeId || command.edgeId) ? "data.write" : "resources.configure";
}
export function assertWritable(state: MockState, scope: Scope) { if (extensions(state).locks[scope.environmentId!]) throw new Refusal("conflict", "Environment writes are paused by a restore operation. Inspect its result before retrying."); }
export function checkJobAuthority(state: MockState, job: ExtensionJob, wall: number) {
  const previous = state.activeSessionId; state.activeSessionId = job.sessionId;
  const ownRestore = job.payload.kind === "command" && job.payload.command.kind === "backup.restore" && job.targetId === job.scope.environmentId;
  const lock = ownRestore ? extensions(state).locks[job.targetId!] : undefined;
  if (ownRestore) delete extensions(state).locks[job.targetId!];
  try { const permission = job.payload.kind === "upload" ? "data.write" : extensionPermission(job.payload.command); environmentAccess(state, { scope: job.scope }, permission, wall); production(state, job.scope, job.production, wall); if (job.payload.kind === "command" && /^(backup|migration)\./.test(job.payload.command.kind)) { environmentAccess(state, { scope: job.scope }, "data.read", wall); environmentAccess(state, { scope: job.scope }, "data.write", wall); } }
  finally { state.activeSessionId = previous; if (lock) extensions(state).locks[job.targetId!] = lock; }
}
export function mutationRecord(state: MockState, scope: Scope, command: ExtensionCommand, options: CommandOptions) {
  const ext = extensions(state);
  if ("id" in command && command.id) {
    const records = command.kind.startsWith("bucket.") ? ext.buckets : command.kind.startsWith("blob.") ? ext.blobs : command.kind.startsWith("vector.") ? ext.vectors : command.kind.startsWith("graph.") ? ext.graphs : command.kind.startsWith("migration.") ? ext.migrations : ext.backups;
    const record = scoped(records as Record<string, { scope: Scope; revision: string }>, scope, command.id); checkRevision(record.revision, options);
  }
}
export function auditExtension(state: MockState, scope: Scope, action: string, resourceId: string, requestId: string, wall: number) { dataAudit(state, scope, requireSession(state, wall).accountId, action, resourceId, requestId, wall); }
