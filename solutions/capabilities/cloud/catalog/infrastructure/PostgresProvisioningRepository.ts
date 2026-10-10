import { randomUUID } from 'node:crypto';
import { PostgresPlatformAuthority } from '@carbon/identity';
import { PlatformFault, parseComponent, type ServiceError } from '@carbon/contracts/platform';
import type { ProvisioningRepository, ProvisioningWork, ProvisioningResult } from '../application/ports/EnvironmentProvisioner.ts';

export class PostgresProvisioningRepository extends PostgresPlatformAuthority implements ProvisioningRepository {
  private async currentRows(tx: Bun.TransactionSQL, row: Record<string, any>) {
    return (await tx`SELECT p.authority_revision::text AS project_revision, e.authority_revision::text AS environment_revision, p.state AS project_state, e.state AS environment_state
      FROM projects p JOIN environments e ON e.project_id = p.id AND e.org_id = p.org_id
      WHERE p.id = ${row.project_id} AND p.org_id = ${row.org_id} AND e.id = ${row.environment_id}`)[0];
  }
  private async event(tx: Bun.TransactionSQL, row: Record<string, any>, action: string) {
    const env = (await tx`UPDATE environments SET revision = revision + 1, updated_at = now() WHERE id = ${row.environment_id} RETURNING revision::text`)[0].revision;
    await tx`UPDATE projects SET revision = revision + 1, updated_at = now() WHERE id = ${row.project_id}`;
    await tx`UPDATE organizations SET revision = revision + 1 WHERE id = ${row.org_id}`;
    await tx`INSERT INTO catalog_events (id, org_id, project_id, environment_id, actor_account_id, action, revision, request_id)
      VALUES (${randomUUID()}, ${row.org_id}, ${row.project_id}, ${row.environment_id}, ${row.actor.id}, ${action}, ${env}, ${row.request_id})`;
  }
  private async authority(tx: Bun.TransactionSQL, row: Record<string, any>) {
    const session = (await tx`SELECT s.token_hash, s.csrf_hash, s.security_revision::text, a.permission_revision::text FROM account_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ${row.actor.credentialId} AND s.account_id = ${row.actor.id}`)[0];
    if (!session) throw new PlatformFault('unauthenticated', 'The operation actor session is no longer valid');
    const access = await this.resolveInTransaction(tx, { accountId: row.actor.id, sessionId: row.actor.credentialId, securityRevision: session.security_revision,
      permissionRevision: session.permission_revision, tokenHash: session.token_hash, csrfHash: session.csrf_hash },
      { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id }, undefined,
      row.kind === 'environment.ensure' ? undefined : 'environment-resume');
    if (!access.permissions.includes('resources.configure')) throw new PlatformFault('forbidden', 'The operation actor no longer has permission');
    return access;
  }
  private async settle(tx: Bun.TransactionSQL, row: Record<string, any>, error?: ServiceError) {
    if (row.cancellation_requested || error) {
      await tx`UPDATE operation_steps SET state = ${row.cancellation_requested ? 'cancelled' : 'failed'}, error = ${error ? JSON.stringify(error) : null}::text::jsonb, completed_at = now()
        WHERE operation_id = ${row.id} AND state IN ('queued', 'running')`;
      await tx`UPDATE service_bindings SET state = 'failed', revision = revision + 1, updated_at = now()
        WHERE operation_id = ${row.id} AND id IN (SELECT binding_id FROM operation_steps WHERE operation_id = ${row.id} AND state <> 'succeeded')`;
    }
    const steps = await tx<{ state: string; error: ServiceError | null }[]>`SELECT state, error FROM operation_steps WHERE operation_id = ${row.id}`;
    const succeeded = steps.filter(step => step.state === 'succeeded').length;
    const pending = steps.some(step => ['queued', 'running'].includes(step.state));
    const state = pending ? 'queued' : row.cancellation_requested ? (succeeded ? 'partially_succeeded' : 'cancelled')
      : error || succeeded !== steps.length ? (succeeded ? 'partially_succeeded' : 'failed') : 'succeeded';
    const fault = error ?? steps.find(step => step.error)?.error ?? null;
    await tx`UPDATE operations SET state = ${state}, revision = revision + 1, error = ${fault ? JSON.stringify(fault) : null}::text::jsonb,
      completed_at = CASE WHEN ${pending} THEN NULL ELSE now() END, lease_id = NULL, lease_expires_at = NULL WHERE id = ${row.id}`;
    if (state === 'succeeded' && row.kind === 'environment.resume') await tx`UPDATE environments SET state = 'active' WHERE id = ${row.environment_id}`;
    await this.event(tx, row, `provisioning.${state}`);
  }
  async claim(): Promise<ProvisioningWork | 'settled' | null> {
    const candidates = await this.sql<{ id: string; org_id: string; actor: { id: string } }[]>`SELECT id, org_id, actor FROM operations
      WHERE state IN ('queued', 'running', 'cancel_requested') AND (lease_expires_at IS NULL OR lease_expires_at <= now()) ORDER BY created_at, id LIMIT 10`;
    for (const candidate of candidates) {
      const result = await this.sql.begin(async tx => {
        const orgLock = await tx`SELECT id FROM organizations WHERE id = ${candidate.org_id} FOR UPDATE SKIP LOCKED`;
        if (!orgLock.length) return null;
        await this.lockAccounts(tx, [candidate.actor.id]);
        const rows = await tx`SELECT *, project_revision::text, environment_revision::text FROM operations WHERE id = ${candidate.id}
          AND state IN ('queued', 'running', 'cancel_requested') AND (lease_expires_at IS NULL OR lease_expires_at <= now()) FOR UPDATE`;
        const row = rows[0]; if (!row) return null;
        const scope = { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id };
        // Reclaimed leases reuse the same owning-service idempotency key; only the attempt changes.
        await tx`UPDATE operation_attempts SET completed_at = now(), outcome = 'interrupted' WHERE step_id IN
          (SELECT id FROM operation_steps WHERE operation_id = ${row.id}) AND completed_at IS NULL`;
        await tx`UPDATE operation_steps SET state = 'queued' WHERE operation_id = ${row.id} AND state = 'running'`;
        if (row.cancellation_requested) { await this.settle(tx, row); return 'settled' as const; }
        let access; let org;
        try {
          const parents = await this.currentRows(tx, row);
          if (!parents || parents.project_revision !== row.project_revision || parents.environment_revision !== row.environment_revision) throw new PlatformFault('conflict', 'Catalog changed before execution; review and retry');
          access = await this.authority(tx, row);
          org = await this.organization(tx, row.org_id, row.actor.id);
        } catch (error) {
          const code = error instanceof PlatformFault ? error.code : 'unavailable';
          await this.settle(tx, row, parseComponent('ServiceError', { code, message: 'Catalog or account authority changed; review the environment and retry', requestId: row.request_id }));
          return 'settled' as const;
        }
        const steps = await tx`SELECT s.*, b.owner, b.remote_resource_id FROM operation_steps s JOIN service_bindings b ON b.id = s.binding_id
          WHERE s.operation_id = ${row.id} AND s.state = 'queued' AND b.operation_id = s.operation_id ORDER BY b.owner LIMIT 1`;
        const step = steps[0];
        if (!step) { await this.settle(tx, row); return 'settled' as const; }
        const leaseId = randomUUID();
        row.actor = parseComponent('Principal', { ...row.actor, permissionRevision: access!.permissionRevision });
        const attempt = (await tx`SELECT COALESCE(max(attempt), 0) + 1 AS next FROM operation_attempts WHERE step_id = ${step.id}`)[0].next;
        await tx`UPDATE operations SET state = 'running', started_at = COALESCE(started_at, now()), revision = revision + 1,
          actor = ${JSON.stringify(row.actor)}::text::jsonb, lease_id = ${leaseId}, lease_expires_at = now() + interval '45 seconds' WHERE id = ${row.id}`;
        await tx`UPDATE operation_steps SET state = 'running', attempt = ${attempt}, started_at = now(), completed_at = NULL WHERE id = ${step.id}`;
        await tx`INSERT INTO operation_attempts (id, step_id, attempt, lease_id) VALUES (${randomUUID()}, ${step.id}, ${attempt}, ${leaseId})`;
        // Operation progress changes invalidate catalog pages without invalidating its own work preconditions.
        await this.event(tx, row, 'provisioning.running');
        return { operationId: row.id, stepId: step.id, bindingId: step.binding_id, leaseId, scope, owner: step.owner, action: step.kind,
          principal: parseComponent('Principal', row.actor), role: org!.role, grants: access!.permissions.map(permission => ({ permission, scope })),
          remoteResourceId: step.remote_resource_id, requestId: row.request_id } as ProvisioningWork;
      });
      if (result) return result;
    }
    return null;
  }
  async complete(work: ProvisioningWork, result: { value: ProvisioningResult } | { error: ServiceError }): Promise<boolean> {
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${work.scope.orgId} FOR UPDATE`;
      await this.lockAccounts(tx, [work.principal.id]);
      const row = (await tx`SELECT *, project_revision::text, environment_revision::text FROM operations WHERE id = ${work.operationId} AND lease_id = ${work.leaseId}
        AND org_id = ${work.scope.orgId} AND project_id = ${work.scope.projectId!} AND environment_id = ${work.scope.environmentId!}
        AND lease_expires_at > now() AND state IN ('running', 'cancel_requested') FOR UPDATE`)[0];
      if (!row) return false;
      const step = (await tx`SELECT id FROM operation_steps WHERE id = ${work.stepId} AND binding_id = ${work.bindingId} AND operation_id = ${row.id} AND state = 'running'`)[0];
      if (!step) return false;
      const parents = await this.currentRows(tx, row);
      let changed = !parents || parents.project_revision !== row.project_revision || parents.environment_revision !== row.environment_revision;
      try { await this.authority(tx, row); } catch { changed = true; }
      const success = 'value' in result;
      // Save already-completed remote work even if permissions changed while the request was in flight.
      // The next claim rechecks authority before starting any further remote work.
      await tx`UPDATE operation_steps SET state = ${success ? 'succeeded' : 'failed'}, completed_at = now(), error = ${success ? null : JSON.stringify(result.error)}::text::jsonb WHERE id = ${work.stepId}`;
      await tx`UPDATE operation_attempts SET outcome = ${success ? 'succeeded' : 'failed'}, completed_at = now(), error = ${success ? null : JSON.stringify(result.error)}::text::jsonb WHERE step_id = ${work.stepId} AND lease_id = ${work.leaseId}`;
      if (success) {
        const saved = await tx`UPDATE service_bindings SET state = ${result.value.state === 'paused' ? 'paused' : 'ready'}, remote_resource_id = ${result.value.remoteResourceId}, revision = revision + 1, updated_at = now()
          WHERE id = ${work.bindingId} AND operation_id = ${row.id} AND (remote_resource_id IS NULL OR remote_resource_id = ${result.value.remoteResourceId}) RETURNING id`;
        if (!saved.length) throw new Error('Service binding changed before completion');
      } else await tx`UPDATE service_bindings SET state = 'failed', revision = revision + 1, updated_at = now() WHERE id = ${work.bindingId} AND operation_id = ${row.id}`;
      const error = changed ? parseComponent('ServiceError', { code: 'conflict', message: 'Catalog changed during execution; completed service work was preserved', requestId: row.request_id }) : undefined;
      await this.settle(tx, row, error);
      return true;
    });
  }
}
