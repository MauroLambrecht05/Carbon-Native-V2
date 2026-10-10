import { randomUUID } from 'node:crypto';
import { PostgresPlatformAuthority, bodyDigest, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import { PlatformFault, parseComponent, canonicalDataImportRequest, validateImportExecutionResult, type DataImportJobCreate, type DataImportJobCancel, type DataImportExecutionResult,
  type EnvironmentScope, type ServiceError, type Role, type DataImportExecution } from '@carbon/contracts/platform';
import type { ImportJobs, ImportLease } from '../application/ports/ImportJobs.ts';
import { PostgresAccountDataAuthority } from './PostgresAccountDataAuthority.ts';
import { importExecutionDigest } from '../domain/ImportExecution.ts';

type Job = Record<string, any>;
const pending = ['queued', 'running', 'cancel_requested'];
const scopeOf = (row: Job): EnvironmentScope => ({ orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id });
const context = (id: string, scope: EnvironmentScope, binding: string) => `data-import:${id}:${scope.orgId}:${scope.projectId}:${scope.environmentId}:${binding}`;
const safeError = (error: unknown, requestId: string, message = 'Import authority or configuration changed; review the operation'): ServiceError => ({
  code: error instanceof PlatformFault ? error.code : 'unavailable', message, requestId,
  ...(error instanceof PlatformFault && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
});

export class PostgresImportJobs extends PostgresPlatformAuthority implements ImportJobs {
  constructor(sql: Bun.SQL, private readonly protector: MessageProtector) { super(sql); }
  private transaction<T>(work: (tx: Bun.TransactionSQL) => Promise<T>) {
    return this.sql.begin(async tx => { await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '5s'`; return work(tx); }) as Promise<T>;
  }
  private async locks(tx: Bun.TransactionSQL, scope: EnvironmentScope, actor: OrganizationActor) {
    await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR UPDATE`; await this.lockAccounts(tx, [actor.accountId]);
  }
  private async access(tx: Bun.TransactionSQL, actor: OrganizationActor, scope: EnvironmentScope, execute: boolean) {
    const current = await this.actor(tx, actor); const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes(execute ? 'data.write' : 'metadata.read')) throw new PlatformFault('forbidden', 'Import access is not permitted');
    if (execute && !current.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
    const org = await this.organization(tx, scope.orgId, actor.accountId);
    return { access, role: org.role as Role, principal: parseComponent('Principal', { id: actor.accountId, kind: 'account', audience: 'dashboard', credentialId: actor.sessionId, permissionRevision: actor.permissionRevision }) };
  }
  private async parents(tx: Bun.TransactionSQL, scope: EnvironmentScope, bindingId?: string) {
    const rows = await tx`SELECT b.id AS binding_id, p.authority_revision::text AS project_revision, e.authority_revision::text AS environment_revision
      FROM projects p JOIN environments e ON e.project_id = p.id AND e.org_id = p.org_id
      JOIN service_bindings b ON b.environment_id = e.id AND b.project_id = p.id AND b.org_id = p.org_id
      WHERE p.id = ${scope.projectId} AND p.org_id = ${scope.orgId} AND e.id = ${scope.environmentId} AND b.owner = 'database'
        AND b.state IN ('ready', 'paused') AND b.remote_resource_id IS NOT NULL AND (${bindingId ?? null}::uuid IS NULL OR b.id = ${bindingId ?? null}::uuid)
      FOR SHARE OF p, e, b`;
    if (rows.length !== 1) throw new PlatformFault('capability', 'Database binding is not available'); return rows[0];
  }
  private async event(tx: Bun.TransactionSQL, row: Job, action: string, detail: Record<string, unknown> = {}) {
    await tx`INSERT INTO data_import_job_events (id, operation_id, action, detail) VALUES (${randomUUID()}, ${row.id}, ${action}, ${JSON.stringify(detail)}::text::jsonb)`;
  }
  private projection(row: Job) {
    const terminal = !pending.includes(row.state);
    return parseComponent('DataImportJobView', { tableId: row.table_id, outcomeUnknown: row.outcome_unknown, result: row.result,
      operation: { id: row.id, kind: 'data.import', actor: row.actor, scope: scopeOf(row), state: row.state, revision: String(row.revision), idempotencyDigest: row.request_digest,
        steps: [{ id: row.id, kind: 'database.rows.import', state: row.state, attempt: Math.max(1, row.attempt), ...(row.error ? { error: row.error } : {}) }],
        progress: terminal ? 100 : 0, cancellationRequested: row.cancellation_requested, createdAt: row.created_at.toISOString(),
        ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}), ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
        ...(row.error ? { error: row.error } : {}), results: row.result && (row.result.inserted || row.result.updated) ? [{ owner: 'database', kind: 'table', id: row.table_id }] : [],
        requestId: row.request_id, metadata: {} } });
  }
  async enqueue(actor: OrganizationActor, scope: EnvironmentScope, input: DataImportJobCreate, requestId: string) {
    scope = parseComponent('EnvironmentScope', { orgId: scope.orgId.toLowerCase(), projectId: scope.projectId.toLowerCase(), environmentId: scope.environmentId.toLowerCase() });
    const parsed = parseComponent('DataImportJobCreate', structuredClone(input)); parseComponent('Id', requestId);
    const create = { ...parsed, commandId: parsed.commandId.toLowerCase(), tableId: parsed.tableId.toLowerCase(),
      access: { ...parsed.access, ...(parsed.access.userId ? { userId: parsed.access.userId.toLowerCase() } : {}) } };
    if (Buffer.byteLength(create.input.text) > 262144) throw new PlatformFault('validation', 'Import source exceeds 256 KiB');
    const initial = await new PostgresAccountDataAuthority(this.sql).authorize(actor, scope, 'data.write', true);
    const command = parseComponent('DataImportExecution', { ...create, kind: 'rows.import.apply' });
    const digest = importExecutionDigest(scope, initial.bindingId, command); const id = randomUUID();
    const sealed = await this.protector.seal(JSON.stringify(command), context(id, scope, initial.bindingId));
    return this.transaction(async tx => {
      await this.locks(tx, scope, actor); const current = await this.access(tx, actor, scope, true); const parents = await this.parents(tx, scope, initial.bindingId);
      const lock = JSON.stringify([actor.accountId, command.commandId]); await tx`SELECT pg_advisory_xact_lock(1128354375, hashtext(${lock}))`;
      const existing = await tx`SELECT id, revision::text, request_digest FROM data_import_jobs WHERE actor_id = ${actor.accountId} AND command_id = ${command.commandId}`;
      if (existing.length) {
        if (existing[0].request_digest !== digest) throw new PlatformFault('conflict', 'Import command ID was used for a different request');
        return parseComponent('DataImportJobReceipt', { operationId: existing[0].id, revision: existing[0].revision, commandId: command.commandId });
      }
      const count = (await tx`SELECT count(*)::int AS count FROM data_import_jobs WHERE org_id = ${scope.orgId} AND state IN ('queued', 'running', 'cancel_requested')`)[0].count;
      if (count >= 100) throw new PlatformFault('quota', 'The organization has too many pending imports');
      await tx`INSERT INTO data_import_jobs (id, org_id, project_id, environment_id, binding_id, table_id, command_id, actor_id, actor, authority_actor,
        project_revision, environment_revision, request_digest, request_id, sealed_execution)
        VALUES (${id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${initial.bindingId}, ${command.tableId}, ${command.commandId}, ${actor.accountId},
          ${JSON.stringify(current.principal)}::text::jsonb, ${JSON.stringify(actor)}::text::jsonb, ${parents.project_revision}, ${parents.environment_revision}, ${digest}, ${requestId}, ${sealed})`;
      await this.event(tx, { id }, 'import.queued', { actorId: actor.accountId });
      return parseComponent('DataImportJobReceipt', { operationId: id, revision: '1', commandId: command.commandId });
    });
  }
  async get(actor: OrganizationActor, scope: EnvironmentScope, id: string) {
    parseComponent('Id', id); return this.transaction(async tx => {
      await this.locks(tx, scope, actor); await this.access(tx, actor, scope, false);
      const rows = await tx`SELECT *, revision::text FROM data_import_jobs WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}`;
      if (!rows.length) throw new PlatformFault('not_found', 'Import operation not found'); return this.projection(rows[0]);
    });
  }
  async cancel(actor: OrganizationActor, scope: EnvironmentScope, id: string, input: DataImportJobCancel) {
    id = parseComponent('Id', id).toLowerCase(); const parsed = parseComponent('DataImportJobCancel', input);
    const command = { ...parsed, commandId: parsed.commandId.toLowerCase() };
    const digest = bodyDigest(JSON.stringify({ kind: 'import.cancel', id, revision: command.revision }));
    return this.transaction(async tx => {
      await this.locks(tx, scope, actor); const current = await this.access(tx, actor, scope, false);
      const rows = await tx`SELECT *, revision::text FROM data_import_jobs WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`;
      const row = rows[0]; if (!row) throw new PlatformFault('not_found', 'Import operation not found');
      if (row.actor_id !== actor.accountId && !current.access.permissions.includes('organization.manage')) throw new PlatformFault('forbidden', 'Only the creator or an organization manager can cancel this import');
      const old = await tx`SELECT request_digest, result FROM data_import_job_commands WHERE actor_id = ${actor.accountId} AND command_id = ${command.commandId}`;
      if (old.length) { if (old[0].request_digest !== digest) throw new PlatformFault('conflict', 'Cancellation ID was reused'); return parseComponent('DataImportJobReceipt', old[0].result); }
      if (row.revision !== command.revision || !pending.includes(row.state)) throw new PlatformFault('conflict', 'Import revision changed or operation is terminal');
      const immediate = row.attempt === 0;
      const changed = await tx`UPDATE data_import_jobs SET cancellation_requested = true, state = ${immediate ? 'cancelled' : 'cancel_requested'}, revision = revision + 1,
        completed_at = CASE WHEN ${immediate} THEN now() ELSE NULL END, sealed_execution = CASE WHEN ${immediate} THEN '' ELSE sealed_execution END
        WHERE id = ${id} RETURNING revision::text`;
      const receipt = parseComponent('DataImportJobReceipt', { operationId: id, revision: changed[0].revision, commandId: command.commandId });
      await tx`INSERT INTO data_import_job_commands (actor_id, command_id, operation_id, request_digest, result) VALUES (${actor.accountId}, ${command.commandId}, ${id}, ${digest}, ${JSON.stringify(receipt)}::text::jsonb)`;
      await this.event(tx, row, immediate ? 'import.cancelled' : 'import.cancel_requested', { actorId: actor.accountId }); return receipt;
    });
  }
  private async current(tx: Bun.TransactionSQL, row: Job, execute: boolean) {
    const actor = { ...row.authority_actor } as OrganizationActor;
    if (!execute) {
      const account = (await tx`SELECT permission_revision::text FROM accounts WHERE id = ${actor.accountId}`)[0];
      if (!account) throw new PlatformFault('forbidden', 'Import account is unavailable');
      Object.assign(actor, { permissionRevision: account.permission_revision });
    }
    const current = await this.access(tx, actor, scopeOf(row), execute);
    const parents = await this.parents(tx, scopeOf(row), row.binding_id);
    if (execute && (String(parents.project_revision) !== String(row.project_revision) || String(parents.environment_revision) !== String(row.environment_revision))) throw new PlatformFault('conflict', 'Import parent configuration changed');
    return current;
  }
  private async terminal(tx: Bun.TransactionSQL, row: Job, state: 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled', result: DataImportExecutionResult | null, error: ServiceError | null, unknown: boolean) {
    await tx`UPDATE data_import_jobs SET state = ${state}, result = ${result ? JSON.stringify(result) : null}::text::jsonb, error = ${error ? JSON.stringify(error) : null}::text::jsonb,
      outcome_unknown = ${unknown}, completed_at = now(), revision = revision + 1, lease_id = NULL, lease_expires_at = NULL,
      sealed_execution = CASE WHEN ${unknown} THEN sealed_execution ELSE '' END WHERE id = ${row.id}`;
    await tx`UPDATE data_import_job_attempts SET completed_at = now(), outcome = ${state === 'cancelled' ? 'cancelled' : state === 'succeeded' ? 'succeeded' : 'failed'}, error = ${error ? JSON.stringify(error) : null}::text::jsonb
      WHERE operation_id = ${row.id} AND completed_at IS NULL`;
    await this.event(tx, row, `import.${state}`, { outcomeUnknown: unknown });
  }
  async claim(): Promise<ImportLease | 'settled' | null> {
    const candidates = await this.sql`SELECT * FROM data_import_jobs WHERE state IN ('queued', 'running', 'cancel_requested') AND next_attempt_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at <= now()) ORDER BY created_at, id LIMIT 10`;
    for (const candidate of candidates) {
      let command: DataImportExecution | undefined;
      try { command = parseComponent('DataImportExecution', JSON.parse(await this.protector.open(candidate.sealed_execution, context(candidate.id, scopeOf(candidate), candidate.binding_id)))); } catch { /* Recorded after locks below. */ }
      const claimed = await this.transaction(async tx => {
        const org = await tx`SELECT id FROM organizations WHERE id = ${candidate.org_id} FOR UPDATE SKIP LOCKED`; if (!org.length) return null;
        await this.lockAccounts(tx, [candidate.actor_id]);
        const row = (await tx`SELECT *, revision::text, project_revision::text, environment_revision::text FROM data_import_jobs WHERE id = ${candidate.id}
          AND state IN ('queued', 'running', 'cancel_requested') AND next_attempt_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now()) FOR UPDATE`)[0];
        if (!row) return null;
        await tx`UPDATE data_import_job_attempts SET completed_at = now(), outcome = 'interrupted' WHERE operation_id = ${row.id} AND completed_at IS NULL`;
        const phase = row.attempt > 0 || row.cancellation_requested || row.deadline_at <= new Date() ? 'reconcile' : 'execute';
        let current;
        try {
          if (!command || row.sealed_execution !== candidate.sealed_execution || importExecutionDigest(scopeOf(row), row.binding_id, command) !== row.request_digest) throw new PlatformFault('unavailable', 'Import source cannot be verified');
          current = await this.current(tx, row, phase === 'execute');
        } catch (error) {
          await this.terminal(tx, row, 'failed', null, safeError(error, row.request_id), row.dispatched_at !== null); return 'settled' as const;
        }
        const leaseId = randomUUID(); const request = { scope: scopeOf(row), bindingId: row.binding_id, operationId: row.id, leaseId, command: command! };
        const allowed = row.retryable && row.attempt < 8 && row.deadline_at > new Date();
        await tx`UPDATE data_import_jobs SET state = ${row.cancellation_requested ? 'cancel_requested' : 'running'}, phase = ${phase}, attempt = attempt + 1,
          revision = revision + 1, started_at = COALESCE(started_at, now()), lease_id = ${leaseId}, lease_expires_at = now() + interval '45 seconds',
          dispatch_digest = ${bodyDigest(canonicalDataImportRequest(request))}, dispatched_at = CASE WHEN ${phase === 'execute'} THEN COALESCE(dispatched_at, now()) ELSE dispatched_at END WHERE id = ${row.id}`;
        await tx`INSERT INTO data_import_job_attempts (id, operation_id, attempt, lease_id, phase) VALUES (${randomUUID()}, ${row.id}, ${row.attempt + 1}, ${leaseId}, ${phase})`;
        await this.event(tx, row, `import.${phase}`, { attempt: row.attempt + 1 });
        return { request, principal: current.principal, role: current.role, requestId: row.request_id, phase, cancelled: row.cancellation_requested,
          retryable: allowed, error: row.error } satisfies ImportLease;
      });
      if (claimed) return claimed;
    }
    return null;
  }
  private async leased(tx: Bun.TransactionSQL, work: ImportLease): Promise<Job | undefined> {
    return (await tx`SELECT *, revision::text, project_revision::text, environment_revision::text FROM data_import_jobs WHERE id = ${work.request.operationId}
      AND lease_id = ${work.request.leaseId} AND lease_expires_at > clock_timestamp() AND state IN ('running', 'cancel_requested') FOR UPDATE`)[0];
  }
  async allowExecution(work: ImportLease): Promise<ImportLease | null> {
    return this.transaction(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${work.request.scope.orgId} FOR UPDATE`; await this.lockAccounts(tx, [work.principal.id]);
      const row = await this.leased(tx, work); if (!row) return null;
      if (row.phase !== 'reconcile' || work.phase !== 'reconcile') throw new PlatformFault('conflict', 'Execution requires receipt reconciliation first');
      if (row.cancellation_requested) { await this.terminal(tx, row, 'cancelled', null, null, false); return null; }
      if (!work.retryable || row.deadline_at <= new Date()) { await this.terminal(tx, row, 'failed', null, row.error ?? safeError(new PlatformFault('unavailable', ''), row.request_id, 'Import execution deadline expired'), false); return null; }
      let current;
      try { current = await this.current(tx, row, true); } catch (error) { await this.terminal(tx, row, 'failed', null, safeError(error, row.request_id), false); return null; }
      await tx`UPDATE data_import_jobs SET phase = 'execute', dispatched_at = COALESCE(dispatched_at, now()), lease_expires_at = now() + interval '45 seconds', revision = revision + 1 WHERE id = ${row.id}`;
      await tx`UPDATE data_import_job_attempts SET phase = 'execute' WHERE lease_id = ${work.request.leaseId}`;
      return { ...work, principal: current.principal, role: current.role, phase: 'execute', cancelled: false };
    });
  }
  async finish(work: ImportLease, result: DataImportExecutionResult | null) {
    if (result) validateImportExecutionResult(result, work.request.command);
    return this.transaction(async tx => {
      const row = await this.leased(tx, work); if (!row) return false;
      if (result && (result.commandId !== row.command_id || result.tableId !== row.table_id)) throw new PlatformFault('conflict', 'Import result does not match the operation');
      if (!result && row.phase !== 'reconcile') throw new PlatformFault('conflict', 'An unconfirmed execution cannot be settled');
      const state = result ? result.failed === 0 ? 'succeeded' : result.failed === result.total ? 'failed' : 'partially_succeeded' : row.cancellation_requested ? 'cancelled' : 'failed';
      const error = result?.failed ? safeError(new PlatformFault('validation', ''), row.request_id, 'Some import rows were rejected') : !result && state === 'failed' ? row.error ?? safeError(new PlatformFault('unavailable', ''), row.request_id, 'Import did not complete') : null;
      await this.terminal(tx, row, state, result, error, false); return true;
    });
  }
  async reconcile(work: ImportLease, error: ServiceError, retryable: boolean) {
    parseComponent('ServiceError', error); return this.transaction(async tx => {
      const row = await this.leased(tx, work); if (!row) return false;
      if (work.phase === 'reconcile' && (row.attempt >= 8 || row.deadline_at <= new Date())) { await this.terminal(tx, row, 'failed', null, error, row.dispatched_at !== null); return true; }
      await tx`UPDATE data_import_jobs SET phase = 'reconcile', error = ${JSON.stringify(error)}::text::jsonb, retryable = ${retryable}, revision = revision + 1,
        lease_id = NULL, lease_expires_at = NULL, next_attempt_at = now() + (${Math.min(60, 2 ** row.attempt)} * interval '1 second') WHERE id = ${row.id}`;
      await tx`UPDATE data_import_job_attempts SET completed_at = now(), outcome = 'interrupted', error = ${JSON.stringify(error)}::text::jsonb WHERE lease_id = ${work.request.leaseId}`;
      await this.event(tx, row, 'import.reconcile_pending'); return true;
    });
  }
  async review(work: ImportLease, error: ServiceError) {
    return this.transaction(async tx => { const row = await this.leased(tx, work); if (!row) return false;
      await this.terminal(tx, row, 'failed', null, parseComponent('ServiceError', error), row.dispatched_at !== null); return true; });
  }
}
