import { parseComponent } from '@carbon/contracts/platform';

export function project(row: Record<string, any>) {
  return parseComponent('CatalogProject', { id: row.id, orgId: row.org_id, name: row.name, slug: row.slug, state: row.state,
    revision: row.revision, productionMutationsAllowed: row.production_mutations_allowed, createdAt: row.created_at.toISOString() });
}
export function environment(row: Record<string, any>) {
  return parseComponent('CatalogEnvironment', { id: row.id, orgId: row.org_id, projectId: row.project_id, name: row.name, kind: row.kind, state: row.state,
    revision: row.revision, provisioning: row.provisioning, createdAt: row.created_at.toISOString() });
}
export function binding(row: Record<string, any>) {
  return parseComponent('ServiceBinding', { id: row.id, scope: { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id },
    owner: row.owner, state: row.state, desiredState: row.desired_state, remoteResourceId: row.remote_resource_id, operationId: row.operation_id, revision: row.revision });
}
export async function operationProjection(tx: Bun.TransactionSQL, row: Record<string, any>) {
  const steps = await tx<{ id: string; binding_id: string; owner: string; kind: string; state: string; attempt: number; error: unknown }[]>`SELECT s.id, s.binding_id, b.owner, s.kind, s.state, s.attempt, s.error FROM operation_steps s
    JOIN service_bindings b ON b.id = s.binding_id WHERE s.operation_id = ${row.id} ORDER BY b.owner`;
  return parseComponent('Operation', { id: row.id, kind: row.kind, actor: row.actor, scope: { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id },
    state: row.state, revision: row.revision, idempotencyDigest: row.idempotency_digest, cancellationRequested: row.cancellation_requested,
    steps: steps.map(step => ({ id: step.id, kind: `${step.owner}.${step.kind}`, state: step.state, attempt: step.attempt, ...(step.error ? { error: step.error } : {}) })),
    progress: steps.length ? Math.floor(100 * steps.filter(step => step.state === 'succeeded').length / steps.length) : 0,
    createdAt: row.created_at.toISOString(), ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}), ...(row.error ? { error: row.error } : {}),
    results: steps.filter(step => step.state === 'succeeded').map(step => ({ owner: 'cloud', kind: 'service_binding', id: step.binding_id })), requestId: row.request_id, metadata: {} });
}
