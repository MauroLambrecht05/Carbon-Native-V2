import { randomUUID } from 'node:crypto';
import { PostgresPlatformAuthority, bodyDigest, type OrganizationActor } from '@carbon/identity';
import { PlatformFault, parseComponent, type DataExportCancel, type DataExportCreate, type DataExportJob, type EnvironmentScope, type Role } from '@carbon/contracts/platform';
import type { ExportJobs, ExportLease, ExportPart } from '../application/ports/ExportJobs.ts';
import { PostgresAccountDataAuthority } from './PostgresAccountDataAuthority.ts';

type Job = Record<string, any>;
type Tx = Bun.TransactionSQL;
const LEASE_SECONDS = 120;
const DOWNLOAD_SECONDS = 60;
/** How long a finished export can be downloaded before it is removed. */
const RETENTION_HOURS = 24;
const MAX_ATTEMPTS = 200;
const MAX_ROWS = 5_000_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Exports one environment may have queued or running at once. */
const MAX_OPEN_PER_ENVIRONMENT = 5;

const scopeOf = (row: Job): EnvironmentScope => ({ orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id });
function view(row: Job): DataExportJob {
  return parseComponent('DataExportJob', { id: row.id, scope: scopeOf(row), tableId: row.table_id, format: row.format, state: row.state, rows: Number(row.row_count), bytes: Number(row.byte_count),
    errorCode: row.error_code ?? null, createdBy: row.actor_id, revision: String(row.revision), createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null });
}

export class PostgresExportJobs extends PostgresPlatformAuthority implements ExportJobs {
  private transaction<T>(work: (tx: Tx) => Promise<T>) {
    return this.sql.begin(async tx => { await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '5s'`; return work(tx); }) as Promise<T>;
  }
  private event(tx: Tx, row: Job, action: string, accountId: string | null) {
    return tx`INSERT INTO data_export_events (id, org_id, project_id, environment_id, job_id, actor_account_id, action, revision, request_id)
      VALUES (${randomUUID()}, ${row.org_id}, ${row.project_id}, ${row.environment_id}, ${row.id}, ${accountId}, ${action}, ${row.revision}, ${row.request_id})`;
  }
  /** Resolves a browser caller's access to exports in this environment. Reading rows in bulk needs both permissions. */
  private async access(tx: Tx, actor: OrganizationActor, scope: EnvironmentScope, fresh: boolean) {
    await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`; await this.lockAccounts(tx, [actor.accountId], true);
    const current = await this.actor(tx, actor); const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes('data.read') || !access.permissions.includes('metadata.read')) throw new PlatformFault('forbidden', 'Exporting data is not permitted');
    if (fresh && !current.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
    const org = await this.organization(tx, scope.orgId, actor.accountId);
    return { access, role: org.role as Role,
      principal: parseComponent('Principal', { id: actor.accountId, kind: 'account', audience: 'dashboard', credentialId: actor.sessionId, permissionRevision: actor.permissionRevision }) };
  }
  /**
   * The job's own authority, resolved now: the creator's session must still be valid and must still be allowed to read
   * this environment's data, at the account's current permission revision. Throws when it is not.
   */
  private async authority(tx: Tx, row: Job) {
    const actor = { ...row.authority_actor } as OrganizationActor;
    const account = (await tx`SELECT permission_revision::text FROM accounts WHERE id = ${actor.accountId}`)[0];
    if (!account) throw new PlatformFault('forbidden', 'The export account is unavailable');
    Object.assign(actor, { permissionRevision: account.permission_revision });
    const current = await this.access(tx, actor, scopeOf(row), false);
    const binding = await tx`SELECT 1 FROM service_bindings WHERE id = ${row.binding_id} AND environment_id = ${row.environment_id} AND owner = 'database' AND state IN ('ready', 'paused') AND remote_resource_id IS NOT NULL`;
    if (!binding.length) throw new PlatformFault('capability', 'The Database binding is not available');
    return current;
  }
  private async row(tx: Tx, scope: EnvironmentScope, id: string, lock = false): Promise<Job> {
    const rows = lock
      ? await tx<Job[]>`SELECT *, revision::text FROM data_export_jobs WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`
      : await tx<Job[]>`SELECT *, revision::text FROM data_export_jobs WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}`;
    if (!rows.length) throw new PlatformFault('not_found', 'Export not found');
    return rows[0]!;
  }
  /** Ends a job. Its stored parts stay recorded until the sweep deletes their objects, unless the job is ready. */
  private async terminal(tx: Tx, row: Job, state: 'ready' | 'failed' | 'cancelled', errorCode: string | null, accountId: string | null): Promise<Job> {
    const updated = (await tx<Job[]>`UPDATE data_export_jobs SET state = ${state}, error_code = ${errorCode}, completed_at = now(), revision = revision + 1, lease_id = NULL, lease_expires_at = NULL,
      expires_at = CASE WHEN ${state === 'ready'} THEN now() + make_interval(hours => ${RETENTION_HOURS}) ELSE NULL END WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
    await this.event(tx, updated, `export.${state}`, accountId);
    return updated;
  }

  // ── Developers ───────────────────────────────────────────────────────────

  async enqueue(actor: OrganizationActor, scope: EnvironmentScope, input: DataExportCreate, requestId: string) {
    const command = parseComponent('DataExportCreate', structuredClone(input));
    const digest = bodyDigest(JSON.stringify({ scope, command }));
    // Starting a bulk read needs a recently authenticated session, like a mutation does.
    const initial = await new PostgresAccountDataAuthority(this.sql).authorize(actor, scope, 'data.read', true);
    return this.transaction(async tx => {
      const current = await this.access(tx, actor, scope, true);
      await tx`SELECT pg_advisory_xact_lock(1128354376, hashtext(${JSON.stringify([actor.accountId, command.commandId])}))`;
      const existing = (await tx<Job[]>`SELECT *, revision::text FROM data_export_jobs WHERE actor_id = ${actor.accountId} AND command_id = ${command.commandId}`)[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new PlatformFault('conflict', 'Command ID was used for a different export');
        return parseComponent('DataExportReceipt', { job: view(existing) });
      }
      await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
      if ((await tx`SELECT 1 FROM data_export_jobs WHERE environment_id = ${scope.environmentId} AND state IN ('queued', 'running')`).length >= MAX_OPEN_PER_ENVIRONMENT) throw new PlatformFault('quota', 'This environment already has the maximum number of exports in progress', { quota: 'data_exports' });
      const row = (await tx<Job[]>`INSERT INTO data_export_jobs (id, org_id, project_id, environment_id, binding_id, table_id, command_id, actor_id, authority_actor, request, request_digest, request_id, format)
        VALUES (${randomUUID()}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${initial.bindingId}, ${command.tableId}, ${command.commandId}, ${actor.accountId},
          ${JSON.stringify({ ...actor, permissionRevision: current.principal.permissionRevision })}::text::jsonb, ${JSON.stringify(command)}::text::jsonb, ${digest}, ${requestId}, ${command.format}) RETURNING *, revision::text`)[0]!;
      await this.event(tx, row, 'export.queued', actor.accountId);
      return parseComponent('DataExportReceipt', { job: view(row) });
    });
  }

  async get(actor: OrganizationActor, scope: EnvironmentScope, id: string) {
    return this.transaction(async tx => { await this.access(tx, actor, scope, false); return view(await this.row(tx, scope, id)); });
  }

  async list(actor: OrganizationActor, scope: EnvironmentScope) {
    return this.transaction(async tx => {
      await this.access(tx, actor, scope, false);
      return (await tx<Job[]>`SELECT *, revision::text FROM data_export_jobs WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
        ORDER BY created_at DESC, id LIMIT 50`).map(view);
    });
  }

  async cancel(actor: OrganizationActor, scope: EnvironmentScope, id: string, input: DataExportCancel) {
    const command = parseComponent('DataExportCancel', input); const digest = bodyDigest(JSON.stringify({ scope, id, command }));
    return this.transaction(async tx => {
      const current = await this.access(tx, actor, scope, false); const row = await this.row(tx, scope, id, true);
      if (row.actor_id !== actor.accountId && !current.access.permissions.includes('organization.manage')) throw new PlatformFault('forbidden', 'Only the creator or an organization manager can cancel this export');
      const old = (await tx`SELECT request_digest, result FROM data_export_commands WHERE actor_id = ${actor.accountId} AND command_id = ${command.commandId}`)[0];
      if (old) { if (old.request_digest !== digest) throw new PlatformFault('conflict', 'Command ID was used for a different request'); return parseComponent('DataExportReceipt', old.result); }
      if (row.revision !== command.revision) throw new PlatformFault('conflict', 'The export changed; refresh before retrying');
      if (!['queued', 'running'].includes(row.state)) throw new PlatformFault('conflict', 'This export is already finished');
      // A worker holding the job learns at its next checkpoint; nobody holding it means it ends now.
      const held = row.lease_expires_at && row.lease_expires_at > new Date();
      const updated = held
        ? (await tx<Job[]>`UPDATE data_export_jobs SET cancellation_requested = true, revision = revision + 1 WHERE id = ${row.id} RETURNING *, revision::text`)[0]!
        : await this.terminal(tx, row, 'cancelled', 'cancelled', actor.accountId);
      if (held) await this.event(tx, updated, 'export.cancel_requested', actor.accountId);
      const receipt = parseComponent('DataExportReceipt', { job: view(updated) });
      await tx`INSERT INTO data_export_commands (actor_id, command_id, job_id, request_digest, result) VALUES (${actor.accountId}, ${command.commandId}, ${row.id}, ${digest}, ${JSON.stringify(receipt)}::text::jsonb)`;
      return receipt;
    });
  }

  async issueDownload(actor: OrganizationActor, scope: EnvironmentScope, id: string, tokenHash: string, requestId: string) {
    parseComponent('Id', requestId);
    return this.transaction(async tx => {
      // Taking the data out needs a recently authenticated session, and only the person whose access produced it may.
      await this.access(tx, actor, scope, true); const row = await this.row(tx, scope, id, true);
      if (row.actor_id !== actor.accountId) throw new PlatformFault('forbidden', 'Only the person who created this export can download it');
      if (row.state !== 'ready' || row.expires_at <= new Date()) throw new PlatformFault('conflict', 'This export is not available for download');
      const issued = (await tx<{ expires_at: Date }[]>`INSERT INTO data_export_downloads (token_hash, job_id, account_id, expires_at)
        VALUES (${tokenHash}, ${row.id}, ${actor.accountId}, now() + make_interval(secs => ${DOWNLOAD_SECONDS})) RETURNING expires_at`)[0]!;
      await this.event(tx, row, 'export.download_issued', actor.accountId);
      return issued.expires_at.toISOString();
    });
  }

  async openDownload(tokenHash: string) {
    return this.transaction(async tx => {
      const token = (await tx<Job[]>`SELECT * FROM data_export_downloads WHERE token_hash = ${tokenHash} FOR UPDATE`)[0];
      if (!token || token.used_at || token.expires_at <= new Date()) return null;
      const row = (await tx<Job[]>`SELECT *, revision::text FROM data_export_jobs WHERE id = ${token.job_id} FOR UPDATE`)[0];
      if (!row || row.state !== 'ready' || row.expires_at <= new Date()) return null;
      // The token is spent whatever happens next: a refused attempt cannot be retried with the same address.
      await tx`UPDATE data_export_downloads SET used_at = now() WHERE token_hash = ${tokenHash}`;
      // Authority is checked again now, not when the address was issued.
      try { await this.authority(tx, row); } catch (error) { if (error instanceof PlatformFault) { await this.event(tx, row, 'export.download_refused', token.account_id); return null; } throw error; }
      const parts = await tx<{ object_key: string }[]>`SELECT object_key FROM data_export_parts WHERE job_id = ${row.id} ORDER BY number`;
      await this.event(tx, row, 'export.downloaded', token.account_id);
      return { jobId: row.id as string, format: row.format as 'jsonl' | 'csv', bytes: Number(row.byte_count), objectKeys: parts.map(part => part.object_key) };
    });
  }

  // ── Cloud's own worker ───────────────────────────────────────────────────

  async claim(): Promise<ExportLease | 'settled' | null> {
    const candidates = await this.sql<{ id: string }[]>`SELECT id FROM data_export_jobs WHERE state IN ('queued', 'running') AND next_attempt_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at <= now()) ORDER BY created_at, id LIMIT 10`;
    for (const candidate of candidates) {
      const claimed = await this.transaction(async tx => {
        const row = (await tx<Job[]>`SELECT *, revision::text, table_revision::text FROM data_export_jobs WHERE id = ${candidate.id} AND state IN ('queued', 'running') AND next_attempt_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at <= now()) FOR UPDATE SKIP LOCKED`)[0];
        if (!row) return null;
        if (row.cancellation_requested) { await this.terminal(tx, row, 'cancelled', 'cancelled', null); return 'settled' as const; }
        if (row.deadline_at <= new Date()) { await this.terminal(tx, row, 'failed', 'deadline_exceeded', null); return 'settled' as const; }
        if (row.attempt >= MAX_ATTEMPTS) { await this.terminal(tx, row, 'failed', 'attempts_exhausted', null); return 'settled' as const; }
        let current;
        try { current = await this.authority(tx, row); }
        catch (error) { if (!(error instanceof PlatformFault)) throw error; await this.terminal(tx, row, 'failed', error.code === 'capability' ? 'binding_unavailable' : 'access_revoked', null); return 'settled' as const; }
        const leaseId = randomUUID();
        const updated = (await tx<Job[]>`UPDATE data_export_jobs SET state = 'running', attempt = attempt + 1, revision = revision + 1, started_at = COALESCE(started_at, now()), lease_id = ${leaseId},
          lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}) WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
        if (row.attempt === 0) await this.event(tx, updated, 'export.started', null);
        return { jobId: row.id, leaseId, scope: scopeOf(row), bindingId: row.binding_id, principal: current.principal, role: current.role, requestId: row.request_id,
          request: parseComponent('DataExportCreate', row.request), afterRowId: row.after_row_id ?? null, parts: row.part_count, tableRevision: row.table_revision ?? null } satisfies ExportLease;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  /** The job, if this lease still holds it. */
  private async leased(tx: Tx, lease: ExportLease): Promise<Job | undefined> {
    return (await tx<Job[]>`SELECT *, revision::text FROM data_export_jobs WHERE id = ${lease.jobId} AND lease_id = ${lease.leaseId} AND lease_expires_at > clock_timestamp() AND state = 'running' FOR UPDATE`)[0];
  }

  async checkpoint(lease: ExportLease, part: ExportPart): Promise<'continue' | 'stop'> {
    return this.transaction(async tx => {
      const row = await this.leased(tx, lease); if (!row) return 'stop';
      if (row.cancellation_requested) { await this.terminal(tx, row, 'cancelled', 'cancelled', null); return 'stop'; }
      if (part.number !== row.part_count + 1) return 'stop';
      if (Number(row.row_count) + part.rows > MAX_ROWS || Number(row.byte_count) + part.bytes > MAX_BYTES) { await this.terminal(tx, row, 'failed', 'too_large', null); return 'stop'; }
      // The object was written before this call. Recording the part and moving the checkpoint are one step.
      await tx`INSERT INTO data_export_parts (job_id, number, object_key, row_count, byte_count, sha256) VALUES (${row.id}, ${part.number}, ${part.objectKey}, ${part.rows}, ${part.bytes}, ${part.sha256})`;
      await tx`UPDATE data_export_jobs SET part_count = ${part.number}, row_count = row_count + ${part.rows}, byte_count = byte_count + ${part.bytes}, after_row_id = COALESCE(${part.afterRowId}::uuid, after_row_id),
        table_revision = ${part.tableRevision}::bigint, lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}) WHERE id = ${row.id}`;
      return 'continue';
    });
  }

  async finish(lease: ExportLease) {
    return this.transaction(async tx => {
      const row = await this.leased(tx, lease); if (!row) return false;
      if (row.cancellation_requested) { await this.terminal(tx, row, 'cancelled', 'cancelled', null); return false; }
      await this.terminal(tx, row, 'ready', null, null); return true;
    });
  }

  async fail(lease: ExportLease, code: string) {
    return this.transaction(async tx => { const row = await this.leased(tx, lease); if (!row) return false; await this.terminal(tx, row, 'failed', code, null); return true; });
  }

  async release(lease: ExportLease, retryAfterSeconds: number) {
    return this.transaction(async tx => {
      const row = await this.leased(tx, lease); if (!row) return false;
      if (row.cancellation_requested) { await this.terminal(tx, row, 'cancelled', 'cancelled', null); return true; }
      await tx`UPDATE data_export_jobs SET lease_id = NULL, lease_expires_at = NULL, next_attempt_at = now() + make_interval(secs => ${retryAfterSeconds}) WHERE id = ${row.id}`;
      return true;
    });
  }

  async expire() {
    return this.transaction(async tx => {
      const rows = await tx<Job[]>`UPDATE data_export_jobs SET state = 'expired', revision = revision + 1 WHERE id IN (SELECT id FROM data_export_jobs WHERE state = 'ready' AND expires_at <= now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)
        RETURNING *, revision::text`;
      for (const row of rows) await this.event(tx, row, 'export.expired', null);
      return rows.length;
    });
  }

  async purgeable(limit: number) {
    return (await this.sql<{ job_id: string; number: number; object_key: string }[]>`SELECT p.job_id, p.number, p.object_key FROM data_export_parts p JOIN data_export_jobs j ON j.id = p.job_id
      WHERE j.state IN ('failed', 'cancelled', 'expired') ORDER BY p.job_id, p.number LIMIT ${limit}`).map(row => ({ jobId: row.job_id, number: row.number, objectKey: row.object_key }));
  }

  async purged(jobId: string, number: number) {
    await this.sql`DELETE FROM data_export_parts p USING data_export_jobs j WHERE j.id = p.job_id AND p.job_id = ${jobId} AND p.number = ${number} AND j.state IN ('failed', 'cancelled', 'expired')`;
  }
}
