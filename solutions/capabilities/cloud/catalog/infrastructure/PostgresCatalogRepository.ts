import { randomUUID } from 'node:crypto';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import { PlatformFault, parseComponent, type Scope, type Permission, type ServiceOwner, type CatalogReceipt } from '@carbon/contracts/platform';
import type { CatalogMutation, CatalogRepository } from '../application/ports/CatalogRepository.ts';
import { project, environment, binding, operationProjection } from './CatalogProjection.ts';

/** How long a deleted project or environment can still be recovered. */
const DELETION_WINDOW_DAYS = 7;

export class PostgresCatalogRepository extends PostgresPlatformAuthority implements CatalogRepository {
  private async require(tx: Bun.TransactionSQL, actor: OrganizationActor, scope: Scope, permission: Permission,
    intent?: 'project-restore' | 'environment-resume' | 'production-create' | 'project-recover' | 'environment-recover') {
    const access = await this.resolveInTransaction(tx, actor, scope, undefined, intent);
    if (!access.permissions.includes(permission)) throw new PlatformFault('forbidden', 'This catalog action is not allowed');
    return access;
  }
  private async projectRow(tx: Bun.TransactionSQL, scope: Scope) {
    const rows = await tx`SELECT *, revision::text FROM projects WHERE id = ${scope.projectId!} AND org_id = ${scope.orgId} AND state <> 'deleted'`;
    if (!rows.length) throw new PlatformFault('not_found', 'Project not found'); return rows[0];
  }
  private async environmentRows(tx: Bun.TransactionSQL, scope: Scope, limit: number, afterId?: string) {
    return tx<Record<string, any>[]>`SELECT e.*, e.revision::text, CASE
      WHEN NOT EXISTS (SELECT 1 FROM service_bindings b WHERE b.environment_id = e.id) THEN 'unconfigured'
      WHEN EXISTS (SELECT 1 FROM service_bindings b JOIN operations o ON o.id = b.operation_id WHERE b.environment_id = e.id AND o.state IN ('failed', 'partially_succeeded', 'cancelled')) THEN 'degraded'
      WHEN EXISTS (SELECT 1 FROM service_bindings b WHERE b.environment_id = e.id AND b.state = 'failed') THEN 'degraded'
      WHEN EXISTS (SELECT 1 FROM service_bindings b WHERE b.environment_id = e.id AND (b.state = 'pending' OR b.state <> CASE WHEN b.desired_state = 'paused' THEN 'paused' ELSE 'ready' END)) THEN 'pending'
      ELSE 'ready' END AS provisioning
      FROM environments e WHERE e.org_id = ${scope.orgId} AND e.project_id = ${scope.projectId!} AND e.state <> 'deleted'
        AND (${scope.environmentId ?? null}::uuid IS NULL OR e.id = ${scope.environmentId ?? null}::uuid)
        AND (${afterId ?? null}::uuid IS NULL OR e.id > ${afterId ?? null}::uuid) ORDER BY e.id LIMIT ${limit}`;
  }
  async get(actor: OrganizationActor, scope: Scope) {
    return this.sql.begin(async tx => {
      await this.require(tx, actor, scope, 'metadata.read');
      if (!scope.environmentId) return project(await this.projectRow(tx, scope));
      const rows = await this.environmentRows(tx, scope, 1);
      if (!rows.length) throw new PlatformFault('not_found', 'Environment not found');
      const bindings = await tx<Record<string, any>[]>`SELECT *, revision::text FROM service_bindings WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId!} AND environment_id = ${scope.environmentId} ORDER BY owner`;
      return parseComponent('CatalogEnvironmentDetails', { environment: environment(rows[0]!), bindings: bindings.map(binding) });
    });
  }
  async list(actor: OrganizationActor, scope: Scope, limit: number, afterId?: string, revision?: string) {
    return this.sql.begin(async tx => {
      const access = await this.require(tx, actor, scope, 'metadata.read');
      const currentRevision = scope.projectId ? access.projectRevision! : access.organizationRevision;
      if (revision && revision !== currentRevision) throw new PlatformFault('conflict', 'The catalog changed; restart the list');
      if (scope.projectId) return { items: (await this.environmentRows(tx, scope, limit, afterId)).map(environment), revision: currentRevision };
      const rows = await tx<Record<string, any>[]>`SELECT p.*, p.revision::text FROM projects p JOIN memberships m ON m.org_id = p.org_id
        WHERE p.org_id = ${scope.orgId} AND m.account_id = ${actor.accountId} AND m.state = 'active' AND p.state <> 'deleted'
          AND (m.project_access = 'all' OR (m.project_access = 'role' AND m.role IN ('Owner', 'Admin'))
            OR EXISTS (SELECT 1 FROM project_assignments a WHERE a.membership_id = m.id AND a.project_id = p.id AND a.org_id = p.org_id))
          AND (${afterId ?? null}::uuid IS NULL OR p.id > ${afterId ?? null}::uuid) ORDER BY p.id LIMIT ${limit}`;
      return { items: rows.map(project), revision: currentRevision };
    });
  }
  async operation(actor: OrganizationActor, scope: Scope, operationId: string) {
    return this.sql.begin(async tx => {
      await this.require(tx, actor, scope, 'metadata.read');
      const row = await this.operationRow(tx, scope, operationId); return operationProjection(tx, row);
    });
  }
  private async operationRow(tx: Bun.TransactionSQL, scope: Scope, operationId: string) {
    const rows = await tx`SELECT *, revision::text FROM operations WHERE id = ${operationId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId!} AND environment_id = ${scope.environmentId!}`;
    if (!rows.length) throw new PlatformFault('not_found', 'Operation not found'); return rows[0];
  }
  private principal(actor: OrganizationActor) {
    return parseComponent('Principal', { id: actor.accountId, kind: 'account', audience: 'dashboard', credentialId: actor.sessionId, permissionRevision: actor.permissionRevision });
  }
  private async queue(tx: Bun.TransactionSQL, mutation: CatalogMutation, scope: Scope, kind: 'ensure' | 'pause' | 'resume', services?: readonly ServiceOwner[]) {
    const active = await tx`SELECT id FROM operations WHERE environment_id = ${scope.environmentId!} AND state IN ('queued', 'running', 'cancel_requested')`;
    if (active.length) throw new PlatformFault('conflict', 'An environment operation is already active');
    const operationId = randomUUID();
    await tx`INSERT INTO operations (id, org_id, project_id, environment_id, kind, actor, idempotency_digest, request_id)
      VALUES (${operationId}, ${scope.orgId}, ${scope.projectId!}, ${scope.environmentId!}, ${`environment.${kind}`}, ${JSON.stringify(this.principal(mutation.actor))}::text::jsonb, ${mutation.keyDigest}, ${mutation.requestId})`;
    if (services) for (const owner of services) await tx`INSERT INTO service_bindings (id, org_id, project_id, environment_id, owner, operation_id)
      VALUES (${randomUUID()}, ${scope.orgId}, ${scope.projectId!}, ${scope.environmentId!}, ${owner}, ${operationId})`;
    const bindings = await tx`UPDATE service_bindings SET operation_id = ${operationId}, desired_state = ${kind === 'pause' ? 'paused' : 'active'},
      state = 'pending', revision = revision + ${services ? 0 : 1}, updated_at = now() WHERE environment_id = ${scope.environmentId!} RETURNING id`;
    if (!bindings.length) throw new PlatformFault('capability', 'This environment has no configured service bindings');
    for (const row of bindings) await tx`INSERT INTO operation_steps (id, operation_id, binding_id, org_id, project_id, environment_id, kind)
      VALUES (${randomUUID()}, ${operationId}, ${row.id}, ${scope.orgId}, ${scope.projectId!}, ${scope.environmentId!}, ${kind})`;
    return operationId;
  }
  async execute(mutation: CatalogMutation): Promise<CatalogReceipt> {
    try { return await this.sql.begin(async tx => {
      const { actor: inputActor, command, scope } = mutation;
      await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR UPDATE`;
      await this.lockAccounts(tx, [inputActor.accountId]); const current = await this.actor(tx, inputActor, command.action !== 'project-create');
      const actor = { ...inputActor, permissionRevision: current.permission_revision as string };
      const org = await this.organization(tx, scope.orgId, actor.accountId); this.mfaGuard(org, current);
      const cancelling = command.action === 'operation-command' && command.input.kind === 'cancel';
      if (org.state !== 'active' && !cancelling) throw new PlatformFault('forbidden', 'This organization is not active');
      const p = scope.projectId ? await this.projectRow(tx, scope) : undefined;
      const e = scope.environmentId ? (await this.environmentRows(tx, scope, 1))[0] : undefined;
      const operation = command.action === 'operation-command' ? await this.operationRow(tx, scope, command.operationId) : undefined;
      const deleting = (command.action === 'project-command' || command.action === 'environment-command') && command.input.kind === 'delete' ? command.input : undefined;
      const intent = deleting ? (command.action === 'project-command' ? (deleting.deleted ? 'project-restore' : 'project-recover') : (deleting.deleted ? 'environment-resume' : 'environment-recover'))
        : command.action === 'project-command' && command.input.kind === 'archive' ? 'project-restore'
        : command.action === 'environment-create' && command.input.kind === 'production' ? 'production-create'
        : ((command.action === 'environment-command' && command.input.kind === 'pause') || command.action === 'operation-command') ? 'environment-resume' : undefined;
      const permission = cancelling ? 'metadata.read' : command.action === 'project-create' || (command.action === 'project-command' && (command.input.kind === 'archive' || command.input.kind === 'delete')) ? 'projects.create' : 'resources.configure';
      await this.require(tx, actor, scope, permission, intent);
      if (deleting && !['Owner', 'Admin'].includes(org.role)) throw new PlatformFault('forbidden', 'An organization administrator must delete or recover this resource');
      if (command.action === 'operation-command' && e && e.state === 'deletion_pending') throw new PlatformFault('conflict', 'This environment is scheduled for deletion');
      if (command.action === 'project-command' && command.input.kind === 'production-policy' && !['Owner', 'Admin'].includes(org.role)) throw new PlatformFault('forbidden', 'An organization administrator must change production policy');
      if (command.action === 'operation-command' && operation!.actor.id !== actor.accountId && !['Owner', 'Admin'].includes(org.role)) throw new PlatformFault('forbidden', 'Only the operation actor or an administrator may change this operation');
      const scopeKey = `catalog:${scope.orgId}:${scope.projectId ?? ''}:${scope.environmentId ?? ''}:${command.action === 'operation-command' ? command.operationId : ''}`;
      const previous = await tx`SELECT request_digest, result FROM catalog_commands WHERE account_id = ${actor.accountId} AND scope_key = ${scopeKey} AND key_digest = ${mutation.keyDigest}`;
      if (previous.length) {
        if (previous[0].request_digest !== mutation.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
        return parseComponent('CatalogReceipt', previous[0].result);
      }
      if (!current.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
      const expected = operation?.revision ?? e?.revision ?? p?.revision ?? org.org_revision;
      if (expected !== mutation.expectedRevision) throw new PlatformFault('conflict', 'The catalog changed; refresh before retrying');
      let resultScope = scope; let operationId: string | undefined; let revision = '1'; let parentRevision = '1';
      if (command.action === 'project-create') {
        const projectId = randomUUID(); const environmentId = randomUUID(); resultScope = { orgId: scope.orgId, projectId, environmentId };
        await tx`INSERT INTO projects (id, org_id, name, slug) VALUES (${projectId}, ${scope.orgId}, ${command.input.name}, ${command.input.slug})`;
        await tx`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${environmentId}, ${scope.orgId}, ${projectId}, 'Development', 'development')`;
        // Creators with explicit projects.create become assigned to their new project.
        await tx`INSERT INTO project_assignments (membership_id, org_id, project_id) VALUES (${org.membership_id}, ${scope.orgId}, ${projectId})`;
        await tx`UPDATE memberships SET revision = revision + 1 WHERE id = ${org.membership_id}`;
        const updated = await tx`UPDATE accounts SET permission_revision = permission_revision + 1, revision = revision + 1, updated_at = now() WHERE id = ${actor.accountId} RETURNING permission_revision::text`;
        operationId = await this.queue(tx, { ...mutation, actor: { ...actor, permissionRevision: updated[0].permission_revision } }, resultScope, 'ensure', command.input.services);
      } else if (command.action === 'environment-create') {
        if (command.input.kind === 'production' && command.input.productionConfirmation !== p!.slug) throw new PlatformFault('validation', 'Confirm the project namespace before creating production');
        const environmentId = randomUUID(); resultScope = { ...scope, environmentId };
        await tx`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${environmentId}, ${scope.orgId}, ${scope.projectId!}, ${command.input.name}, ${command.input.kind})`;
        operationId = await this.queue(tx, mutation, resultScope, 'ensure', command.input.services);
      } else if (command.action === 'project-command') {
        const input = command.input;
        if (input.kind === 'update') await tx`UPDATE projects SET name = ${input.name}, slug = ${input.slug} WHERE id = ${scope.projectId!}`;
        else {
          if (input.confirmation !== p!.slug) throw new PlatformFault('validation', 'Confirm the current project namespace');
          if (input.kind === 'archive') {
            if (!['active', 'archived'].includes(p!.state)) throw new PlatformFault('conflict', 'This project cannot change archive state');
            await tx`UPDATE projects SET state = ${input.archived ? 'archived' : 'active'} WHERE id = ${scope.projectId!}`;
          } else if (input.kind === 'delete') {
            // archived -> deletion_pending -> (after the recovery window) deleted; recovery returns to archived.
            if (input.deleted) {
              if (p!.state !== 'archived') throw new PlatformFault('conflict', 'Archive the project before deleting it');
              await tx`UPDATE projects SET state = 'deletion_pending', deletion_scheduled_at = now() + make_interval(days => ${DELETION_WINDOW_DAYS}), deletion_requested_by = ${actor.accountId} WHERE id = ${scope.projectId!}`;
            } else {
              if (p!.state !== 'deletion_pending') throw new PlatformFault('conflict', 'This project is not scheduled for deletion');
              await tx`UPDATE projects SET state = 'archived', deletion_scheduled_at = NULL, deletion_requested_by = NULL WHERE id = ${scope.projectId!}`;
            }
          } else await tx`UPDATE projects SET production_mutations_allowed = ${input.allowed} WHERE id = ${scope.projectId!}`;
        }
      } else if (command.action === 'environment-command') {
        const input = command.input;
        if (!e) throw new PlatformFault('not_found', 'Environment not found');
        if (input.kind === 'rename') await tx`UPDATE environments SET name = ${input.name} WHERE id = ${scope.environmentId!}`;
        else if (input.kind === 'delete') {
          // paused -> deletion_pending -> (after the recovery window) deleted; recovery returns to paused.
          if (input.confirmation !== p!.slug) throw new PlatformFault('validation', 'Confirm the current project namespace');
          if (input.deleted) {
            if (e.state !== 'paused') throw new PlatformFault('conflict', 'Pause the environment before deleting it');
            if ((await tx`SELECT 1 FROM operations WHERE environment_id = ${scope.environmentId!} AND state IN ('queued', 'running', 'cancel_requested') LIMIT 1`).length) throw new PlatformFault('conflict', 'An environment operation is still active');
            await tx`UPDATE environments SET state = 'deletion_pending', deletion_scheduled_at = now() + make_interval(days => ${DELETION_WINDOW_DAYS}), deletion_requested_by = ${actor.accountId} WHERE id = ${scope.environmentId!}`;
          } else {
            if (e.state !== 'deletion_pending') throw new PlatformFault('conflict', 'This environment is not scheduled for deletion');
            await tx`UPDATE environments SET state = 'paused', deletion_scheduled_at = NULL, deletion_requested_by = NULL WHERE id = ${scope.environmentId!}`;
          }
        } else {
          if (!['active', 'paused'].includes(e.state)) throw new PlatformFault('conflict', 'This environment cannot change pause state');
          if (e.kind === 'production' && input.productionConfirmation !== p!.slug) throw new PlatformFault('validation', 'Confirm the project namespace before changing production');
          operationId = await this.queue(tx, mutation, scope, input.paused ? 'pause' : 'resume');
          // Pausing blocks writes immediately; resume becomes active after service reconciliation.
          await tx`UPDATE environments SET state = 'paused' WHERE id = ${scope.environmentId!}`;
        }
      } else {
        operationId = operation!.id;
        if (command.input.kind === 'retry') {
          if (!['failed', 'partially_succeeded', 'cancelled'].includes(operation!.state)) throw new PlatformFault('conflict', 'Only an unsuccessful operation can be retried');
          const changed = await tx`SELECT id FROM service_bindings WHERE environment_id = ${scope.environmentId!} AND operation_id <> ${operationId!}`;
          if (changed.length) throw new PlatformFault('conflict', 'A newer lifecycle operation replaced this one');
          await tx`UPDATE operations SET state = 'queued', actor = ${JSON.stringify(this.principal(actor))}::text::jsonb, cancellation_requested = false,
            completed_at = NULL, error = NULL, lease_id = NULL, lease_expires_at = NULL, revision = revision + 1 WHERE id = ${operationId!}`;
          await tx`UPDATE operation_steps SET state = 'queued', error = NULL, completed_at = NULL WHERE operation_id = ${operationId!} AND state <> 'succeeded'`;
          await tx`UPDATE service_bindings SET state = 'pending', revision = revision + 1, updated_at = now()
            WHERE operation_id = ${operationId!} AND id IN (SELECT binding_id FROM operation_steps WHERE operation_id = ${operationId!} AND state <> 'succeeded')`;
        } else {
          if (!['queued', 'running', 'cancel_requested'].includes(operation!.state)) throw new PlatformFault('conflict', 'This operation is already complete');
          await tx`UPDATE operations SET state = 'cancel_requested', cancellation_requested = true, revision = revision + 1 WHERE id = ${operationId!}`;
        }
      }
      const orgRevision = (await tx`UPDATE organizations SET revision = revision + 1 WHERE id = ${scope.orgId} RETURNING revision::text`)[0].revision;
      let projectRevision = '1'; let environmentRevision = '1';
      if (scope.projectId) projectRevision = (await tx`UPDATE projects SET revision = revision + 1, updated_at = now() WHERE id = ${scope.projectId} RETURNING revision::text`)[0].revision;
      if (scope.environmentId) environmentRevision = (await tx`UPDATE environments SET revision = revision + 1, updated_at = now() WHERE id = ${scope.environmentId} RETURNING revision::text`)[0].revision;
      if (command.action === 'project-command') await tx`UPDATE projects SET authority_revision = authority_revision + 1 WHERE id = ${scope.projectId!}`;
      if (command.action === 'environment-command') await tx`UPDATE environments SET authority_revision = authority_revision + 1 WHERE id = ${scope.environmentId!}`;
      if (operationId) await tx`UPDATE operations o SET project_revision = p.authority_revision, environment_revision = e.authority_revision
        FROM projects p JOIN environments e ON e.project_id = p.id AND e.org_id = p.org_id WHERE o.id = ${operationId} AND p.id = o.project_id AND e.id = o.environment_id`;
      revision = command.action === 'operation-command' ? (await this.operationRow(tx, scope, operationId!)).revision
        : command.action === 'environment-create' ? '1' : scope.environmentId ? environmentRevision : projectRevision;
      parentRevision = command.action === 'operation-command' ? environmentRevision : resultScope.environmentId && command.action !== 'project-create' ? projectRevision : orgRevision;
      await tx`INSERT INTO catalog_events (id, org_id, project_id, environment_id, actor_account_id, action, revision, request_id)
        VALUES (${randomUUID()}, ${scope.orgId}, ${resultScope.projectId!}, ${resultScope.environmentId ?? null}, ${actor.accountId},
          ${`catalog.${command.action}${'kind' in command.input ? '.' + command.input.kind : ''}`}, ${revision}, ${mutation.requestId})`;
      const receipt = parseComponent('CatalogReceipt', { scope: resultScope, revision, parentRevision, ...(operationId ? { operationId } : {}), message: operationId ? 'Environment operation queued' : 'Catalog updated' });
      await tx`INSERT INTO catalog_commands (account_id, org_id, scope_key, key_digest, request_digest, result)
        VALUES (${actor.accountId}, ${scope.orgId}, ${scopeKey}, ${mutation.keyDigest}, ${mutation.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb)`;
      return receipt;
    }); } catch (error) {
      const constraint = (error as { constraint?: string })?.constraint;
      if (['projects_org_id_slug_key', 'environments_project_name_idx'].includes(constraint ?? '')) throw new PlatformFault('conflict', 'This catalog name or namespace is already in use');
      if (constraint === 'operations_environment_active_idx') throw new PlatformFault('conflict', 'An environment operation is already active');
      throw error;
    }
  }

  /**
   * Makes due deletions final. Rows are kept and marked deleted: every reader already excludes that state, and no
   * owning-service data is destroyed here. Open worker leases for the affected environments are cancelled.
   */
  async finalizeDeletions(requestId: string, limit: number) {
    return this.sql.begin(async tx => {
      const finalized: Scope[] = [];
      const environments = await tx<Record<string, any>[]>`SELECT e.id, e.org_id, e.project_id, e.deletion_requested_by FROM environments e
        WHERE e.state = 'deletion_pending' AND e.deletion_scheduled_at <= now() ORDER BY e.deletion_scheduled_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      const projects = await tx<Record<string, any>[]>`SELECT p.id, p.org_id, p.deletion_requested_by FROM projects p
        WHERE p.state = 'deletion_pending' AND p.deletion_scheduled_at <= now() ORDER BY p.deletion_scheduled_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      const remove = async (row: Record<string, any>, actor: string) => {
        const revision = (await tx`UPDATE environments SET state = 'deleted', deletion_scheduled_at = NULL, revision = revision + 1, authority_revision = authority_revision + 1, updated_at = now()
          WHERE id = ${row.id} RETURNING revision::text`)[0].revision;
        await tx`UPDATE worker_leases SET state = 'cancelled', lease_token_hash = NULL, revision = revision + 1, updated_at = now() WHERE environment_id = ${row.id} AND state IN ('granted', 'claimed')`;
        await tx`INSERT INTO catalog_events (id, org_id, project_id, environment_id, actor_account_id, action, revision, request_id)
          VALUES (${randomUUID()}, ${row.org_id}, ${row.project_id}, ${row.id}, ${actor}, 'catalog.environment.deleted', ${revision}, ${requestId})`;
        finalized.push({ orgId: row.org_id, projectId: row.project_id, environmentId: row.id });
      };
      for (const row of environments) await remove(row, row.deletion_requested_by);
      for (const row of projects) {
        for (const child of await tx<Record<string, any>[]>`SELECT id, org_id, project_id FROM environments WHERE project_id = ${row.id} AND state <> 'deleted' FOR UPDATE`) await remove(child, row.deletion_requested_by);
        const revision = (await tx`UPDATE projects SET state = 'deleted', deletion_scheduled_at = NULL, revision = revision + 1, authority_revision = authority_revision + 1, updated_at = now()
          WHERE id = ${row.id} RETURNING revision::text`)[0].revision;
        await tx`INSERT INTO catalog_events (id, org_id, project_id, environment_id, actor_account_id, action, revision, request_id)
          VALUES (${randomUUID()}, ${row.org_id}, ${row.id}, NULL, ${row.deletion_requested_by}, 'catalog.project.deleted', ${revision}, ${requestId})`;
        finalized.push({ orgId: row.org_id, projectId: row.id });
      }
      return finalized;
    });
  }
}
