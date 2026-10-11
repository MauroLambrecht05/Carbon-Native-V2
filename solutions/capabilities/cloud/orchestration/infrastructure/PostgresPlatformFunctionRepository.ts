import { randomUUID } from 'node:crypto';
import type { HeldLease, LeaseOutcome, PostgresWorkerRepository, WorkerLeaseInput } from '@carbon/catalog';
import {
  PlatformFault, parseComponent, type EnvironmentScope, type Function as PlatformFunction, type FunctionCommand, type FunctionDeploy, type FunctionExecution, type FunctionRevision, type FunctionSchedule,
  type WorkerFunctionComplete,
} from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import type { UsageGate } from '@carbon/billing';
import type { CommandIdentity, PlatformFunctionRepository } from '../application/ports/PlatformFunctionRepository.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
type Permission = 'metadata.read' | 'resources.configure' | 'data.write';
export interface FunctionLimits { readonly functions: number; readonly revisions: number; readonly schedulesPerFunction: number; readonly openExecutions: number }
/** How long an execution may wait for a worker before it is given up on. */
const QUEUE_SECONDS = 600;
/** Time past a function's own timeout before Cloud stops waiting for the worker to report. */
const GRACE_SECONDS = 15;
const MAX_ATTEMPTS = 3;
const MAX_OUTPUT_BYTES = 262144;
const DENIED: Record<Permission, string> = { 'metadata.read': 'Reading functions is not permitted', 'resources.configure': 'Changing functions is not permitted', 'data.write': 'Running functions is not permitted' };

const scopeOf = (row: Row): EnvironmentScope => ({ orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id });
function view(row: Row): PlatformFunction {
  return parseComponent('Function', { id: row.id, scope: scopeOf(row), name: row.name, state: row.state, activeRevision: row.active_revision, latestRevision: row.latest_revision, revision: String(row.revision), createdAt: row.created_at.toISOString() });
}
function revisionView(row: Row): FunctionRevision {
  return parseComponent('FunctionRevision', { number: row.number, codeDigest: row.code_digest, secretNames: row.secret_names, timeoutSeconds: row.timeout_seconds, createdBy: row.created_by, createdAt: row.created_at.toISOString() });
}
function executionView(row: Row): FunctionExecution {
  return parseComponent('FunctionExecution', { id: row.id, scope: scopeOf(row), functionId: row.function_id, revisionNumber: row.revision_number, codeDigest: row.code_digest, state: row.state, trigger: row.trigger,
    scheduleId: row.schedule_id ?? null, retryOf: row.retry_of ?? null, attempt: row.attempt, output: row.output ?? null, errorCategory: row.error_category ?? null, createdBy: row.created_by ?? null, revision: String(row.revision),
    createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null });
}
function scheduleView(row: Row): FunctionSchedule {
  return parseComponent('FunctionSchedule', { id: row.id, functionId: row.function_id, intervalSeconds: row.interval_seconds, state: row.state, nextRunAt: row.next_run_at.toISOString(), lastRunAt: row.last_run_at?.toISOString() ?? null,
    revision: String(row.revision), createdAt: row.created_at.toISOString() });
}

export class PostgresPlatformFunctionRepository extends PostgresPlatformAuthority implements PlatformFunctionRepository {
  constructor(sql: Bun.SQL, private readonly workers: PostgresWorkerRepository, private readonly limits: FunctionLimits = { functions: 50, revisions: 500, schedulesPerFunction: 5, openExecutions: 20 }, private readonly usage?: UsageGate) { super(sql); }

  private async authorize(tx: Tx, input: OrganizationActor, scope: EnvironmentScope, permission: Permission) {
    await this.lockAccounts(tx, [input.accountId], true); const current = await this.actor(tx, input);
    const actor = { ...input, permissionRevision: current.permission_revision as string };
    const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes(permission)) throw new PlatformFault('forbidden', DENIED[permission]);
    return actor;
  }
  private event(tx: Tx, scope: EnvironmentScope, kind: 'function' | 'function_execution' | 'function_schedule', resourceId: string, action: string, revision: string | number, requestId: string, ids: { accountId?: string | null; workerId?: string | null } = {}) {
    return tx`INSERT INTO function_events (id, org_id, project_id, environment_id, resource_kind, resource_id, actor_account_id, worker_id, action, revision, request_id)
      VALUES (${randomUUID()}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${kind}, ${resourceId}, ${ids.accountId ?? null}, ${ids.workerId ?? null}, ${action}, ${revision}, ${requestId})`;
  }
  private async replay<T>(tx: Tx, accountId: string, key: string, command: CommandIdentity, parse: (value: unknown) => T): Promise<T | undefined> {
    const old = (await tx`SELECT request_digest, result FROM function_commands WHERE actor_account_id = ${accountId} AND scope_key = ${key} AND key_digest = ${command.keyDigest}`)[0];
    if (!old) return undefined;
    if (old.request_digest !== command.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
    return parse(old.result);
  }
  private remember(tx: Tx, accountId: string, key: string, command: CommandIdentity, receipt: unknown) {
    return tx`INSERT INTO function_commands VALUES (${accountId}, ${key}, ${command.keyDigest}, ${command.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
  }
  private async row(tx: Tx, scope: EnvironmentScope, id: string, lock = false): Promise<Row> {
    const rows = await tx.unsafe(`SELECT * FROM functions WHERE id = $1 AND org_id = $2 AND project_id = $3 AND environment_id = $4${lock ? ' FOR UPDATE' : ''}`, [id, scope.orgId, scope.projectId, scope.environmentId]);
    if (!rows.length) throw new PlatformFault('not_found', 'Function not found');
    return rows[0];
  }
  private async executionRow(tx: Tx, scope: EnvironmentScope, id: string, lock = false): Promise<Row> {
    const rows = await tx.unsafe(`SELECT * FROM function_executions WHERE id = $1 AND org_id = $2 AND project_id = $3 AND environment_id = $4${lock ? ' FOR UPDATE' : ''}`, [id, scope.orgId, scope.projectId, scope.environmentId]);
    if (!rows.length) throw new PlatformFault('not_found', 'Execution not found');
    return rows[0];
  }

  /**
   * Creates one execution of one exact revision, with the lease it will run on, in the caller's transaction. The lease
   * names exactly the revision's secrets: nothing else can reach the worker.
   */
  private async enqueue(tx: Tx, fn: Row, revision: Row, input: { id: string; leaseId: string; trigger: 'manual' | 'schedule' | 'retry'; scheduleId?: string; scheduledFor?: Date; retryOf?: string; input: unknown;
    createdBy: string | null; requestId: string }): Promise<Row> {
    if (fn.state !== 'active') throw new PlatformFault('conflict', 'This function is disabled');
    const scope = scopeOf(fn);
    // Counted under the environment's lock, so the limit holds when several callers arrive together.
    await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
    if ((await tx`SELECT 1 FROM function_executions WHERE environment_id = ${scope.environmentId} AND state IN ('queued', 'running')`).length >= this.limits.openExecutions) {
      throw new PlatformFault('quota', 'This environment already has the maximum number of executions in progress', { quota: 'function_executions' });
    }
    if (this.usage) {
      // An execution in progress holds one invocation of the month's allowance until it ends. Counted under the organization's usage lock, across all its environments.
      await this.usage.lock(tx, scope.orgId);
      const open = Number((await tx`SELECT count(*)::text AS total FROM function_executions WHERE org_id = ${scope.orgId} AND state IN ('queued', 'running')`)[0].total);
      await this.usage.admit(tx, scope.orgId, 'function_invocations', await this.usage.used(tx, scope.orgId, 'function_invocations') + open + 1, input.requestId);
    }
    const row = (await tx<Row[]>`INSERT INTO function_executions (id, org_id, project_id, environment_id, function_id, revision_number, code_digest, trigger, schedule_id, scheduled_for, retry_of, input, created_by, deadline_at, request_id)
      VALUES (${input.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${fn.id}, ${revision.number}, ${revision.code_digest}, ${input.trigger}, ${input.scheduleId ?? null}, ${input.scheduledFor ?? null},
        ${input.retryOf ?? null}, ${JSON.stringify(input.input ?? null)}::text::jsonb, ${input.createdBy}, now() + make_interval(secs => ${QUEUE_SECONDS + revision.timeout_seconds}), ${input.requestId}) RETURNING *`)[0]!;
    await this.workers.grantIn(tx, { id: input.leaseId, scope, purpose: 'function', subjectId: row.id, secretNames: revision.secret_names, claimSeconds: QUEUE_SECONDS,
      deadlineSeconds: QUEUE_SECONDS + (revision.timeout_seconds + GRACE_SECONDS) * MAX_ATTEMPTS, maxAttempts: MAX_ATTEMPTS, requestId: input.requestId });
    await this.event(tx, scope, 'function_execution', row.id, 'execution.queued', row.revision, input.requestId, { accountId: input.createdBy });
    return row;
  }
  /** Ends an execution and releases its lease. */
  private async finish(tx: Tx, row: Row, state: 'succeeded' | 'failed' | 'timed_out' | 'cancelled', errorCategory: string | null, output: unknown, requestId: string, ids: { accountId?: string | null; workerId?: string | null } = {}): Promise<Row> {
    const updated = (await tx<Row[]>`UPDATE function_executions SET state = ${state}, error_category = ${errorCategory}, output = ${state === 'succeeded' ? JSON.stringify(output ?? null) : null}::text::jsonb,
      completed_at = now(), revision = revision + 1 WHERE id = ${row.id} RETURNING *`)[0]!;
    await this.event(tx, scopeOf(row), 'function_execution', row.id, `execution.${state}`, updated.revision, requestId, ids);
    // Charged once, and only if a worker started it. One that never ran gives its place back by leaving the open states.
    if (this.usage && row.attempt > 0) await this.usage.record(tx, row.org_id, 'function_invocations', 1, `function-execution:${row.id}`);
    return updated;
  }

  // ── Functions ────────────────────────────────────────────────────────────

  async deploy(input: OrganizationActor, scope: EnvironmentScope, functionId: string, value: FunctionDeploy, codeDigest: string, command: CommandIdentity) {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'resources.configure'); const key = `functions:${scope.environmentId}`;
      const existing = await this.replay(tx, actor.accountId, key, command, result => parseComponent('FunctionReceipt', result)); if (existing) return existing;
      await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
      // A revision can only name secrets that exist now. Whether they still exist is checked again when a lease is granted.
      const known = (await tx<{ name: string }[]>`SELECT name FROM environment_secrets WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} AND state = 'active'`).map(row => row.name);
      if (value.secretNames.some(name => !known.includes(name))) throw new PlatformFault('validation', 'A named secret does not exist in this environment');
      let fn = (await tx<Row[]>`SELECT * FROM functions WHERE environment_id = ${scope.environmentId} AND name = ${value.name} FOR UPDATE`)[0];
      if (!fn && (await tx`SELECT 1 FROM functions WHERE environment_id = ${scope.environmentId}`).length >= this.limits.functions) throw new PlatformFault('quota', 'This environment has reached its function limit', { quota: 'functions' });
      if (fn && fn.latest_revision >= this.limits.revisions) throw new PlatformFault('quota', 'This function has reached its revision limit', { quota: 'function_revisions' });
      const number = (fn?.latest_revision ?? 0) + 1;
      // Deploying makes the new revision the active one. Executions already created keep the revision they were created with.
      fn = fn
        ? (await tx<Row[]>`UPDATE functions SET latest_revision = ${number}, active_revision = ${number}, revision = revision + 1 WHERE id = ${fn.id} RETURNING *`)[0]!
        : (await tx<Row[]>`INSERT INTO functions (id, org_id, project_id, environment_id, name, active_revision, latest_revision, created_by) VALUES (${functionId}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${value.name}, 1, 1, ${actor.accountId}) RETURNING *`)[0]!;
      await tx`INSERT INTO function_revisions (function_id, number, code, code_digest, secret_names, timeout_seconds, created_by)
        VALUES (${fn.id}, ${number}, ${value.code}, ${codeDigest}, ${`{${value.secretNames.join(',')}}`}::text[], ${value.timeoutSeconds}, ${actor.accountId})`;
      const receipt = parseComponent('FunctionReceipt', { function: view(fn), message: number === 1 ? 'Function created' : 'Revision deployed' });
      await this.remember(tx, actor.accountId, key, command, receipt);
      await this.event(tx, scope, 'function', fn.id, 'function.deployed', fn.revision, command.requestId, { accountId: actor.accountId });
      return receipt;
    });
  }

  async list(input: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      return (await tx<Row[]>`SELECT * FROM functions WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
        AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${limit}`).map(view);
    });
  }

  async get(input: OrganizationActor, scope: EnvironmentScope, functionId: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read'); const fn = await this.row(tx, scope, functionId);
      const revisions = await tx<Row[]>`SELECT * FROM function_revisions WHERE function_id = ${fn.id} ORDER BY number DESC LIMIT 100`;
      return parseComponent('FunctionDetails', { function: view(fn), revisions: revisions.map(revisionView) });
    });
  }

  async revision(input: OrganizationActor, scope: EnvironmentScope, functionId: string, number: number) {
    return this.sql.begin(async tx => {
      // Code can name how secrets are used; reading it needs the same permission as changing it.
      await this.authorize(tx, input, scope, 'resources.configure'); const fn = await this.row(tx, scope, functionId);
      const row = (await tx<Row[]>`SELECT * FROM function_revisions WHERE function_id = ${fn.id} AND number = ${number}`)[0];
      if (!row) throw new PlatformFault('not_found', 'Revision not found');
      return parseComponent('FunctionRevisionDetails', { revision: revisionView(row), code: row.code });
    });
  }

  async command(input: OrganizationActor, scope: EnvironmentScope, functionId: string, value: FunctionCommand, expectedRevision: string, command: CommandIdentity) {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'resources.configure'); const fn = await this.row(tx, scope, functionId, true); const key = `function:${fn.id}`;
      const existing = await this.replay(tx, actor.accountId, key, command, result => parseComponent('FunctionReceipt', result)); if (existing) return existing;
      if (String(fn.revision) !== expectedRevision) throw new PlatformFault('conflict', 'The function changed; refresh before retrying');
      let updated: Row; let message: string;
      if (value.kind === 'activate') {
        // Going back to an earlier revision is the same operation as going forward: the pointer moves, the revisions do not.
        if (!(await tx`SELECT 1 FROM function_revisions WHERE function_id = ${fn.id} AND number = ${value.revision}`).length) throw new PlatformFault('not_found', 'Revision not found');
        if (fn.active_revision === value.revision) throw new PlatformFault('conflict', 'This revision is already active');
        updated = (await tx<Row[]>`UPDATE functions SET active_revision = ${value.revision}, revision = revision + 1 WHERE id = ${fn.id} RETURNING *`)[0]!; message = 'Revision activated';
      } else {
        const state = value.kind === 'disable' ? 'disabled' : 'active';
        if (fn.state === state) throw new PlatformFault('conflict', `This function is already ${state}`);
        updated = (await tx<Row[]>`UPDATE functions SET state = ${state}, revision = revision + 1 WHERE id = ${fn.id} RETURNING *`)[0]!; message = value.kind === 'disable' ? 'Function disabled' : 'Function enabled';
        if (value.kind === 'disable') {
          // Nothing new starts, and what was waiting or running is stopped: its lease goes first, so no worker can finish it.
          for (const open of await tx<Row[]>`SELECT * FROM function_executions WHERE function_id = ${fn.id} AND state IN ('queued', 'running') ORDER BY id FOR UPDATE`) {
            await this.workers.cancelIn(tx, open.id, command.requestId); await this.finish(tx, open, 'cancelled', 'function_disabled', null, command.requestId, { accountId: actor.accountId });
          }
        }
      }
      const receipt = parseComponent('FunctionReceipt', { function: view(updated), message });
      await this.remember(tx, actor.accountId, key, command, receipt);
      await this.event(tx, scope, 'function', fn.id, value.kind === 'activate' ? 'function.revision_activated' : `function.${value.kind}d`, updated.revision, command.requestId, { accountId: actor.accountId });
      return receipt;
    });
  }

  // ── Executions ───────────────────────────────────────────────────────────

  async invoke(input: OrganizationActor, scope: EnvironmentScope, functionId: string, ids: { executionId: string; leaseId: string }, value: unknown, command: CommandIdentity) {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'data.write'); const fn = await this.row(tx, scope, functionId, true); const key = `invoke:${fn.id}`;
      const existing = await this.replay(tx, actor.accountId, key, command, result => parseComponent('FunctionExecutionReceipt', result)); if (existing) return existing;
      // The revision active at this moment is the one this execution runs, whatever is deployed afterwards.
      const revision = (await tx<Row[]>`SELECT * FROM function_revisions WHERE function_id = ${fn.id} AND number = ${fn.active_revision}`)[0]!;
      const row = await this.enqueue(tx, fn, revision, { id: ids.executionId, leaseId: ids.leaseId, trigger: 'manual', input: value, createdBy: actor.accountId, requestId: command.requestId });
      const receipt = parseComponent('FunctionExecutionReceipt', { execution: executionView(row), message: 'Execution queued' });
      await this.remember(tx, actor.accountId, key, command, receipt);
      return receipt;
    });
  }

  async executions(input: OrganizationActor, scope: EnvironmentScope, functionId: string, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read'); const fn = await this.row(tx, scope, functionId);
      return (await tx<Row[]>`SELECT * FROM function_executions WHERE function_id = ${fn.id} AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${limit}`).map(executionView);
    });
  }

  async execution(input: OrganizationActor, scope: EnvironmentScope, executionId: string) {
    return this.sql.begin(async tx => { await this.authorize(tx, input, scope, 'metadata.read'); return executionView(await this.executionRow(tx, scope, executionId)); });
  }

  async executionCommand(input: OrganizationActor, scope: EnvironmentScope, executionId: string, kind: 'cancel' | 'retry', ids: { executionId: string; leaseId: string }, expectedRevision: string, command: CommandIdentity) {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'data.write'); const row = await this.executionRow(tx, scope, executionId, true); const key = `execution:${row.id}`;
      const existing = await this.replay(tx, actor.accountId, key, command, result => parseComponent('FunctionExecutionReceipt', result)); if (existing) return existing;
      if (String(row.revision) !== expectedRevision) throw new PlatformFault('conflict', 'The execution changed; refresh before retrying');
      const open = ['queued', 'running'].includes(row.state); let result: Row; let message: string;
      if (kind === 'cancel') {
        if (!open) throw new PlatformFault('conflict', 'This execution is already finished');
        await this.workers.cancelIn(tx, row.id, command.requestId);
        result = await this.finish(tx, row, 'cancelled', 'cancelled', null, command.requestId, { accountId: actor.accountId }); message = 'Execution cancelled';
      } else {
        if (open || row.state === 'succeeded') throw new PlatformFault('conflict', 'Only an execution that failed, timed out or was cancelled can be retried');
        const fn = await this.row(tx, scope, row.function_id, true);
        // A retry runs what the original ran: the same revision and the same input, not whatever is active now.
        const revision = (await tx<Row[]>`SELECT * FROM function_revisions WHERE function_id = ${fn.id} AND number = ${row.revision_number}`)[0]!;
        result = await this.enqueue(tx, fn, revision, { id: ids.executionId, leaseId: ids.leaseId, trigger: 'retry', retryOf: row.id, input: row.input, createdBy: actor.accountId, requestId: command.requestId }); message = 'Retry queued';
      }
      const receipt = parseComponent('FunctionExecutionReceipt', { execution: executionView(result), message });
      await this.remember(tx, actor.accountId, key, command, receipt);
      return receipt;
    });
  }

  // ── Schedules ────────────────────────────────────────────────────────────

  private async scheduleRow(tx: Tx, scope: EnvironmentScope, scheduleId: string): Promise<Row> {
    const row = (await tx<Row[]>`SELECT s.* FROM function_schedules s JOIN functions f ON f.id = s.function_id WHERE s.id = ${scheduleId} AND s.state <> 'deleted'
      AND f.org_id = ${scope.orgId} AND f.project_id = ${scope.projectId} AND f.environment_id = ${scope.environmentId} FOR UPDATE OF s`)[0];
    if (!row) throw new PlatformFault('not_found', 'Schedule not found');
    return row;
  }

  async createSchedule(input: OrganizationActor, scope: EnvironmentScope, functionId: string, scheduleId: string, intervalSeconds: number, command: CommandIdentity) {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'resources.configure'); const fn = await this.row(tx, scope, functionId, true); const key = `schedules:${fn.id}`;
      const existing = await this.replay(tx, actor.accountId, key, command, result => parseComponent('FunctionScheduleReceipt', result)); if (existing) return existing;
      if ((await tx`SELECT 1 FROM function_schedules WHERE function_id = ${fn.id} AND state <> 'deleted'`).length >= this.limits.schedulesPerFunction) throw new PlatformFault('quota', 'This function has reached its schedule limit', { quota: 'function_schedules' });
      const row = (await tx<Row[]>`INSERT INTO function_schedules (id, function_id, interval_seconds, next_run_at, created_by) VALUES (${scheduleId}, ${fn.id}, ${intervalSeconds}, now() + make_interval(secs => ${intervalSeconds}), ${actor.accountId}) RETURNING *`)[0]!;
      const receipt = parseComponent('FunctionScheduleReceipt', { schedule: scheduleView(row), message: 'Schedule created' });
      await this.remember(tx, actor.accountId, key, command, receipt);
      await this.event(tx, scope, 'function_schedule', row.id, 'schedule.created', row.revision, command.requestId, { accountId: actor.accountId });
      return receipt;
    });
  }

  async schedules(input: OrganizationActor, scope: EnvironmentScope, functionId: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read'); const fn = await this.row(tx, scope, functionId);
      return (await tx<Row[]>`SELECT * FROM function_schedules WHERE function_id = ${fn.id} AND state <> 'deleted' ORDER BY created_at, id`).map(scheduleView);
    });
  }

  async scheduleCommand(input: OrganizationActor, scope: EnvironmentScope, scheduleId: string, kind: 'pause' | 'resume' | 'delete', expectedRevision: string, command: CommandIdentity) {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'resources.configure'); const row = await this.scheduleRow(tx, scope, scheduleId); const key = `schedule:${row.id}`;
      const existing = await this.replay(tx, actor.accountId, key, command, result => parseComponent('FunctionScheduleReceipt', result)); if (existing) return existing;
      if (String(row.revision) !== expectedRevision) throw new PlatformFault('conflict', 'The schedule changed; refresh before retrying');
      const state = kind === 'pause' ? 'paused' : kind === 'resume' ? 'active' : 'deleted';
      if (row.state === state) throw new PlatformFault('conflict', `This schedule is already ${state}`);
      // Resuming starts a fresh interval from now; the runs missed while paused are not made up.
      const updated = (await tx<Row[]>`UPDATE function_schedules SET state = ${state}, revision = revision + 1,
        next_run_at = CASE WHEN ${kind === 'resume'} THEN now() + make_interval(secs => interval_seconds) ELSE next_run_at END WHERE id = ${row.id} RETURNING *`)[0]!;
      // A deleted schedule is reported as it was, paused: the contract has no deleted state because nothing can read one afterwards.
      const receipt = parseComponent('FunctionScheduleReceipt', { schedule: scheduleView({ ...updated, state: state === 'deleted' ? 'paused' : state }), message: kind === 'pause' ? 'Schedule paused' : kind === 'resume' ? 'Schedule resumed' : 'Schedule deleted' });
      await this.remember(tx, actor.accountId, key, command, receipt);
      await this.event(tx, scope, 'function_schedule', row.id, `schedule.${kind === 'delete' ? 'deleted' : kind === 'pause' ? 'paused' : 'resumed'}`, updated.revision, command.requestId, { accountId: actor.accountId });
      return receipt;
    });
  }

  // ── The worker that holds an execution's lease ───────────────────────────

  private async leased(tx: Tx, held: HeldLease): Promise<LeaseOutcome<Row>> {
    if (held.lease.purpose !== 'function') return { fault: new PlatformFault('not_found', 'This lease is not for a function') };
    const row = (await tx<Row[]>`SELECT * FROM function_executions WHERE id = ${held.lease.subject_id} FOR UPDATE`)[0];
    if (!row) return { fault: new PlatformFault('not_found', 'Execution not found') };
    if (!['queued', 'running'].includes(row.state)) return { fault: new PlatformFault('conflict', 'This execution is already finished') };
    return { value: row };
  }

  async input(lease: WorkerLeaseInput) {
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const leased = await this.leased(tx, held); if ('fault' in leased) return leased; let row = leased.value;
      const revision = (await tx<Row[]>`SELECT * FROM function_revisions WHERE function_id = ${row.function_id} AND number = ${row.revision_number}`)[0]!;
      if (row.attempt !== held.lease.attempt) {
        // A new attempt, on a new lease, gets the function's full time again.
        row = (await tx<Row[]>`UPDATE function_executions SET state = 'running', attempt = ${held.lease.attempt}, started_at = COALESCE(started_at, now()),
          deadline_at = now() + make_interval(secs => ${revision.timeout_seconds + GRACE_SECONDS}), revision = revision + 1 WHERE id = ${row.id} RETURNING *`)[0]!;
        await this.event(tx, scopeOf(row), 'function_execution', row.id, 'execution.attempt_started', row.revision, lease.requestId, { workerId: held.worker.id });
      }
      return { value: parseComponent('WorkerFunctionInput', { executionId: row.id, scope: scopeOf(row), functionId: row.function_id, revisionNumber: revision.number, code: revision.code, codeDigest: revision.code_digest,
        input: row.input, attempt: row.attempt, timeoutSeconds: revision.timeout_seconds }) };
    });
  }

  async complete(lease: WorkerLeaseInput, result: WorkerFunctionComplete) {
    if (result.outcome === 'succeeded' && Buffer.byteLength(JSON.stringify(result.output ?? null)) > MAX_OUTPUT_BYTES) throw new PlatformFault('validation', 'The function output exceeds the size limit');
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const leased = await this.leased(tx, held); if ('fault' in leased) return leased; const row = leased.value;
      if (row.state !== 'running' || row.attempt !== held.lease.attempt) return { fault: new PlatformFault('conflict', 'Fetch the execution input before reporting on it') };
      // A result that arrives after the deadline is not accepted: the execution is timed out by the reconciler instead.
      if (row.deadline_at <= new Date()) return { fault: new PlatformFault('conflict', 'This execution is past its deadline') };
      await this.workers.completeIn(tx, held.lease, lease.requestId);
      const updated = result.outcome === 'succeeded'
        ? await this.finish(tx, row, 'succeeded', null, result.output, lease.requestId, { workerId: held.worker.id })
        // A failure the function reports is its own and is not retried automatically; only a lost worker is.
        : await this.finish(tx, row, result.errorCategory === 'function.timeout' ? 'timed_out' : 'failed', result.errorCategory, null, lease.requestId, { workerId: held.worker.id });
      return { value: executionView(updated) };
    });
  }

  // ── Cloud's own timers ───────────────────────────────────────────────────

  async reconcile(requestId: string, limit: number) {
    return this.sql.begin(async tx => {
      const rows = await tx<Row[]>`SELECT e.* FROM function_executions e WHERE e.state IN ('queued', 'running')
        AND (e.deadline_at <= now() OR NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.subject_id = e.id AND l.state IN ('granted', 'claimed') AND l.expires_at > now()))
        ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT ${limit}`;
      const finished: FunctionExecution[] = [];
      for (const row of rows) {
        const overdue = row.deadline_at <= new Date();
        // A lease that is merely overdue still gets its retry from the lease sweeper first.
        if (!overdue && (await tx`SELECT 1 FROM worker_leases WHERE subject_id = ${row.id} AND state IN ('granted', 'claimed')`).length) continue;
        await this.workers.cancelIn(tx, row.id, requestId);
        finished.push(executionView(overdue ? await this.finish(tx, row, 'timed_out', 'deadline_exceeded', null, requestId)
          : await this.finish(tx, row, 'failed', row.attempt > 0 ? 'worker_lost' : 'no_worker', null, requestId)));
      }
      return finished;
    });
  }

  async tick(requestId: string, limit: number) {
    const due = await this.sql<{ id: string }[]>`SELECT id FROM function_schedules WHERE state = 'active' AND next_run_at <= now() ORDER BY next_run_at LIMIT ${limit}`;
    const created: FunctionExecution[] = [];
    for (const candidate of due) {
      const execution = await this.sql.begin(async tx => {
        // Locked and re-read: two schedulers that both saw this schedule as due cannot both run its slot.
        const schedule = (await tx<Row[]>`SELECT * FROM function_schedules WHERE id = ${candidate.id} AND state = 'active' AND next_run_at <= now() FOR UPDATE SKIP LOCKED`)[0];
        if (!schedule) return undefined;
        const fn = (await tx<Row[]>`SELECT * FROM functions WHERE id = ${schedule.function_id} FOR UPDATE`)[0]!; const scope = scopeOf(fn); const slot = schedule.next_run_at as Date;
        // One run for however many slots were missed, then the next slot after now on the original rhythm.
        await tx`UPDATE function_schedules SET last_run_at = now(), revision = revision + 1,
          next_run_at = next_run_at + make_interval(secs => interval_seconds * (floor(extract(epoch FROM (now() - next_run_at)) / interval_seconds)::integer + 1)) WHERE id = ${schedule.id}`;
        const skip = async (reason: string) => { await this.event(tx, scope, 'function_schedule', schedule.id, `schedule.skipped.${reason}`, Number(schedule.revision) + 1, requestId); return undefined; };
        if (fn.state !== 'active') return skip('function_disabled');
        // The previous run of this schedule has not finished: this slot is skipped rather than piling up.
        if ((await tx`SELECT 1 FROM function_executions WHERE schedule_id = ${schedule.id} AND state IN ('queued', 'running')`).length) return skip('overlap');
        const revision = (await tx<Row[]>`SELECT * FROM function_revisions WHERE function_id = ${fn.id} AND number = ${fn.active_revision}`)[0]!;
        try {
          // In a savepoint, so a refusal part-way leaves no execution without a lease behind.
          return executionView(await tx.savepoint(point => this.enqueue(point as unknown as Tx, fn, revision, { id: randomUUID(), leaseId: randomUUID(), trigger: 'schedule', scheduleId: schedule.id, scheduledFor: slot, input: null, createdBy: null, requestId })) as Row);
        } catch (error) {
          // No room, or a secret the revision names is gone: the slot is skipped and recorded, and the schedule carries on.
          if (error instanceof PlatformFault && ['quota', 'validation', 'not_found', 'conflict'].includes(error.code)) return skip(error.code === 'quota' ? 'limit' : 'unavailable');
          throw error;
        }
      });
      if (execution) created.push(execution);
    }
    return created;
  }
}
