import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type Worker, type WorkerLease, type WorkerLeaseReceipt } from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import type { SecretProtector } from '../application/ports/SecretProtection.ts';
import type {
  WorkerClaimInput, WorkerEnrollInput, WorkerEnrollmentInput, WorkerLeaseGrant, WorkerLeaseInput, WorkerMutation, WorkerRepository, WorkerRotateInput,
} from '../application/ports/WorkerRepository.ts';

/** A claimed lease must be renewed within this window; the worker is told to heartbeat three times as often. */
const HEARTBEAT_SECONDS = 20;
const LEASE_WINDOW_SECONDS = HEARTBEAT_SECONDS * 3;
const WORKER_LIMIT = 100;

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
/** Carries a refusal out of a transaction that still has to commit (an expiry it just recorded). */
type Outcome<T> = { readonly value: T } | { readonly fault: PlatformFault };

function pgArray(value: readonly string[]) { return `{${value.join(',')}}`; }
function worker(row: Row): Worker {
  return parseComponent('Worker', {
    id: row.id, orgId: row.org_id, name: row.name, purposes: row.purposes, capabilities: row.capabilities ?? null, status: row.status,
    credentialExpiresAt: row.credential_expires_at?.toISOString() ?? null, lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revision: row.revision, createdAt: row.created_at.toISOString(),
  });
}
function lease(row: Row): WorkerLease {
  return parseComponent('WorkerLease', {
    id: row.id, workerId: row.worker_id ?? null, scope: { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id },
    purpose: row.purpose, subjectId: row.subject_id, attempt: row.attempt, secretNames: row.secret_names, state: row.state,
    expiresAt: row.expires_at.toISOString(), deadlineAt: row.deadline_at.toISOString(), revision: row.revision,
  });
}
const invalidWorker = () => new PlatformFault('unauthenticated', 'Worker credential is invalid or revoked');
const lostLease = () => new PlatformFault('conflict', 'This lease is no longer held');

export class PostgresWorkerRepository extends PostgresPlatformAuthority implements WorkerRepository {
  constructor(sql: Bun.SQL, private readonly protector?: SecretProtector) { super(sql); }

  private event(tx: Tx, orgId: string, action: string, requestId: string, ids: { workerId?: string | null; leaseId?: string | null; accountId?: string | null }, metadata: unknown = {}) {
    return tx`INSERT INTO worker_events(id, org_id, worker_id, lease_id, account_id, action, request_id, metadata)
      VALUES (${randomUUID()}, ${orgId}, ${ids.workerId ?? null}, ${ids.leaseId ?? null}, ${ids.accountId ?? null}, ${action}, ${requestId}, ${JSON.stringify(metadata)}::text::jsonb)`;
  }

  // ── Organization managers ────────────────────────────────────────────────

  private async manager(tx: Tx, input: OrganizationActor, orgId: string, fresh: boolean) {
    await this.lockAccounts(tx, [input.accountId]); const current = await this.actor(tx, input);
    const actor = { ...input, permissionRevision: current.permission_revision as string };
    const access = await this.resolveInTransaction(tx, actor, { orgId });
    if (!access.permissions.includes('organization.manage')) throw new PlatformFault('forbidden', 'Managing workers is not permitted');
    if (fresh && !current.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
    return actor;
  }
  private async replay(tx: Tx, accountId: string, key: string, input: { keyDigest: string; requestDigest: string }) {
    const old = (await tx`SELECT request_digest, result FROM worker_commands WHERE actor_account_id = ${accountId} AND scope_key = ${key} AND key_digest = ${input.keyDigest}`)[0];
    if (old && old.request_digest !== input.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
    return old;
  }

  async list(input: OrganizationActor, orgId: string, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.manager(tx, input, orgId, false);
      const rows = await tx<Row[]>`SELECT *, revision::text FROM workers WHERE org_id = ${orgId}
        AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${limit}`;
      return rows.map(worker);
    });
  }

  async createEnrollment(input: WorkerEnrollmentInput) {
    try {
      return await this.sql.begin(async tx => {
        const actor = await this.manager(tx, input.actor, input.orgId, true); const key = `worker-enrollment:${input.orgId}`;
        // The code is disclosed once, so a retry is refused instead of answered with a second code.
        if (await this.replay(tx, actor.accountId, key, input)) throw new PlatformFault('conflict', 'This worker enrollment was already issued; its code cannot be shown again');
        const count = (await tx<{ count: number }[]>`SELECT count(*)::integer AS count FROM workers WHERE org_id = ${input.orgId} AND status <> 'revoked'`)[0]!.count;
        if (count >= WORKER_LIMIT) throw new PlatformFault('quota', 'Too many workers in this organization');
        const row = (await tx<Row[]>`INSERT INTO workers(id, org_id, name, purposes, enrollment_hash, enrollment_expires_at, created_by)
          VALUES (${input.id}, ${input.orgId}, ${input.name}, ${pgArray(input.purposes)}::text[], ${input.codeHash}, ${input.expiresAt}, ${actor.accountId}) RETURNING *, revision::text`)[0]!;
        await tx`INSERT INTO worker_commands VALUES (${actor.accountId}, ${key}, ${input.keyDigest}, ${input.requestDigest}, ${JSON.stringify({ workerId: row.id })}::text::jsonb, now())`;
        await this.event(tx, input.orgId, 'worker.enrollment_created', input.requestId, { workerId: row.id, accountId: actor.accountId }, { name: input.name, purposes: input.purposes });
        return parseComponent('WorkerEnrollmentIssue', { worker: worker(row), code: input.code, expiresAt: input.expiresAt.toISOString() });
      });
    } catch (error) {
      if (error instanceof PlatformFault) throw error;
      if ((error as { errno?: string }).errno === '23505') throw new PlatformFault('conflict', 'A worker already uses this name');
      throw error;
    }
  }

  async execute(input: WorkerMutation) {
    return this.sql.begin(async tx => {
      const actor = await this.manager(tx, input.actor, input.orgId, true);
      const row = (await tx<Row[]>`SELECT *, revision::text FROM workers WHERE id = ${input.workerId} AND org_id = ${input.orgId} FOR UPDATE`)[0];
      if (!row) throw new PlatformFault('not_found', 'Worker not found');
      const key = `worker:${row.id}`; const old = await this.replay(tx, actor.accountId, key, input);
      if (old) return parseComponent('WorkerReceipt', old.result);
      if (row.revision !== input.expectedRevision) throw new PlatformFault('conflict', 'Worker changed; refresh before retrying');
      const kind = input.command.kind; let updated: Row;
      if (kind === 'disable') {
        if (row.status !== 'active') throw new PlatformFault('conflict', 'Only an active worker can be disabled');
        updated = (await tx<Row[]>`UPDATE workers SET status = 'disabled', revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      } else if (kind === 'enable') {
        if (row.status !== 'disabled') throw new PlatformFault('conflict', 'Only a disabled worker can be enabled');
        updated = (await tx<Row[]>`UPDATE workers SET status = 'active', revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      } else {
        if (row.status === 'revoked') throw new PlatformFault('conflict', 'Worker is already revoked');
        updated = (await tx<Row[]>`UPDATE workers SET status = 'revoked', token_hash = NULL, token_prefix = NULL, credential_expires_at = NULL,
          enrollment_hash = NULL, enrollment_expires_at = NULL, revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      }
      // A worker that may no longer act loses its leases at once; the work moves to a successor attempt.
      if (kind !== 'enable') for (const held of await tx<Row[]>`SELECT *, revision::text FROM worker_leases WHERE worker_id = ${row.id} AND state = 'claimed' FOR UPDATE`) await this.expire(tx, held, input.requestId, true);
      const receipt = parseComponent('WorkerReceipt', { worker: worker(updated), message: kind === 'disable' ? 'Worker disabled' : kind === 'enable' ? 'Worker enabled' : 'Worker revoked' });
      await tx`INSERT INTO worker_commands VALUES (${actor.accountId}, ${key}, ${input.keyDigest}, ${input.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
      await this.event(tx, input.orgId, kind === 'disable' ? 'worker.disabled' : kind === 'enable' ? 'worker.enabled' : 'worker.revoked', input.requestId, { workerId: row.id, accountId: actor.accountId });
      return receipt;
    });
  }

  // ── The worker ───────────────────────────────────────────────────────────

  async enroll(input: WorkerEnrollInput) {
    return this.sql.begin(async tx => {
      const row = (await tx<Row[]>`SELECT w.*, o.state AS organization_state FROM workers w JOIN organizations o ON o.id = w.org_id WHERE w.enrollment_hash = ${input.codeHash} FOR UPDATE OF w`)[0];
      if (!row || row.status !== 'pending' || row.enrollment_expires_at <= new Date() || row.organization_state !== 'active') throw new PlatformFault('unauthenticated', 'Worker enrollment code is invalid or expired');
      const updated = (await tx<Row[]>`UPDATE workers SET status = 'active', enrollment_hash = NULL, enrollment_expires_at = NULL, capabilities = ${JSON.stringify(input.capabilities)}::text::jsonb,
        token_hash = ${input.tokenHash}, token_prefix = ${input.tokenPrefix}, credential_expires_at = ${input.credentialExpiresAt}, last_seen_at = now(), revision = revision + 1, updated_at = now()
        WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      await this.event(tx, row.org_id, 'worker.enrolled', input.requestId, { workerId: row.id }, { capabilities: input.capabilities });
      return parseComponent('WorkerCredentialIssue', { worker: worker(updated), token: input.token });
    });
  }

  /** Every worker call re-reads the worker, its credential and its organization. */
  private async authenticate(tx: Tx, tokenHash: string): Promise<Row> {
    const row = (await tx<Row[]>`SELECT w.*, w.revision::text, o.state AS organization_state FROM workers w JOIN organizations o ON o.id = w.org_id WHERE w.token_hash = ${tokenHash} FOR UPDATE OF w`)[0];
    if (!row || row.status !== 'active' || row.credential_expires_at <= new Date() || row.organization_state !== 'active') throw invalidWorker();
    await tx`UPDATE workers SET last_seen_at = now() WHERE id = ${row.id}`;
    return row;
  }

  async rotate(input: WorkerRotateInput) {
    return this.sql.begin(async tx => {
      const row = await this.authenticate(tx, input.currentTokenHash);
      const updated = (await tx<Row[]>`UPDATE workers SET token_hash = ${input.tokenHash}, token_prefix = ${input.tokenPrefix}, credential_expires_at = ${input.credentialExpiresAt},
        revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      await this.event(tx, row.org_id, 'worker.credential_rotated', input.requestId, { workerId: row.id });
      return parseComponent('WorkerCredentialIssue', { worker: worker(updated), token: input.token });
    });
  }

  async claim(input: WorkerClaimInput) {
    return this.sql.begin(async tx => {
      const current = await this.authenticate(tx, input.tokenHash);
      const row = (await tx<Row[]>`SELECT l.* FROM worker_leases l JOIN environments e ON e.id = l.environment_id AND e.project_id = l.project_id AND e.org_id = l.org_id
        JOIN projects p ON p.id = l.project_id AND p.org_id = l.org_id
        WHERE l.org_id = ${current.org_id} AND l.state = 'granted' AND l.expires_at > now() AND l.purpose = ANY(${pgArray(current.purposes)}::text[])
          AND (l.required_platform IS NULL OR l.required_platform = ${current.capabilities?.platform ?? null})
          AND (l.worker_id IS NULL OR l.worker_id = ${current.id}) AND e.state = 'active' AND p.state = 'active'
        ORDER BY l.created_at, l.id FOR UPDATE OF l SKIP LOCKED LIMIT 1`)[0];
      if (!row) return parseComponent('WorkerLeaseOffer', { state: 'none' });
      const claimed = (await tx<Row[]>`UPDATE worker_leases SET state = 'claimed', worker_id = ${current.id}, lease_token_hash = ${input.leaseTokenHash},
        expires_at = LEAST(now() + make_interval(secs => ${LEASE_WINDOW_SECONDS}), deadline_at), revision = revision + 1, updated_at = now()
        WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      await this.event(tx, current.org_id, 'lease.claimed', input.requestId, { workerId: current.id, leaseId: row.id }, { attempt: row.attempt });
      return parseComponent('WorkerLeaseOffer', { state: 'leased', lease: lease(claimed), leaseToken: input.leaseToken, heartbeatSeconds: HEARTBEAT_SECONDS });
    });
  }

  /** Marks a lease lost. A claimed lease that still has attempts and time left gets a successor row; the old token is gone for good. */
  private async expire(tx: Tx, row: Row, requestId: string, successor: boolean): Promise<Row | undefined> {
    await tx`UPDATE worker_leases SET state = 'expired', lease_token_hash = NULL, revision = revision + 1, updated_at = now() WHERE id = ${row.id}`;
    await this.event(tx, row.org_id, 'lease.expired', requestId, { workerId: row.worker_id, leaseId: row.id }, { attempt: row.attempt });
    if (!successor || row.attempt >= row.max_attempts || row.deadline_at <= new Date()) return undefined;
    const next = (await tx<Row[]>`INSERT INTO worker_leases(id, org_id, project_id, environment_id, purpose, subject_id, attempt, max_attempts, secret_names, required_platform, expires_at, deadline_at)
      VALUES (${randomUUID()}, ${row.org_id}, ${row.project_id}, ${row.environment_id}, ${row.purpose}, ${row.subject_id}, ${row.attempt + 1}, ${row.max_attempts},
        ${pgArray(row.secret_names)}::text[], ${row.required_platform}, LEAST(now() + interval '5 minutes', ${row.deadline_at}), ${row.deadline_at}) RETURNING *, revision::text`)[0]!;
    await this.event(tx, row.org_id, 'lease.granted', requestId, { leaseId: next.id }, { attempt: next.attempt, previousLeaseId: row.id });
    return next;
  }

  /** The lease must belong to this worker, carry this lease token and still be inside its window. */
  private async held(tx: Tx, input: WorkerLeaseInput): Promise<Outcome<{ worker: Row; lease: Row }>> {
    const current = await this.authenticate(tx, input.tokenHash);
    const row = (await tx<Row[]>`SELECT *, revision::text FROM worker_leases WHERE id = ${input.leaseId} AND worker_id = ${current.id} FOR UPDATE`)[0];
    if (!row) return { fault: new PlatformFault('not_found', 'Lease not found') };
    if (row.state === 'cancelled') return { value: { worker: current, lease: row } };
    if (row.state !== 'claimed' || row.lease_token_hash !== input.leaseTokenHash) return { fault: lostLease() };
    if (row.expires_at <= new Date()) { await this.expire(tx, row, input.requestId, true); return { fault: lostLease() }; }
    return { value: { worker: current, lease: row } };
  }
  private async settle<T>(work: (tx: Tx) => Promise<Outcome<T>>): Promise<T> {
    const outcome = await this.sql.begin(work);
    if ('fault' in outcome) throw outcome.fault;
    return outcome.value;
  }

  async heartbeat(input: WorkerLeaseInput) {
    return this.settle<WorkerLeaseReceipt>(async tx => {
      const held = await this.held(tx, input); if ('fault' in held) return held;
      const row = held.value.lease;
      if (row.state === 'cancelled') return { value: parseComponent('WorkerLeaseReceipt', { lease: lease(row), cancelled: true }) };
      const updated = (await tx<Row[]>`UPDATE worker_leases SET expires_at = LEAST(now() + make_interval(secs => ${LEASE_WINDOW_SECONDS}), deadline_at), updated_at = now()
        WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      return { value: parseComponent('WorkerLeaseReceipt', { lease: lease(updated), cancelled: false }) };
    });
  }

  async complete(input: WorkerLeaseInput) {
    return this.settle<WorkerLeaseReceipt>(async tx => {
      const held = await this.held(tx, input); if ('fault' in held) return held;
      const row = held.value.lease;
      // Cancellation wins: a cancelled lease can never become a success.
      if (row.state === 'cancelled') return { fault: new PlatformFault('conflict', 'This lease was cancelled') };
      const updated = (await tx<Row[]>`UPDATE worker_leases SET state = 'completed', lease_token_hash = NULL, revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      await this.event(tx, row.org_id, 'lease.completed', input.requestId, { workerId: row.worker_id, leaseId: row.id });
      return { value: parseComponent('WorkerLeaseReceipt', { lease: lease(updated), cancelled: false }) };
    });
  }

  /**
   * Decrypts the secrets a lease names, once. Values exist only in this response: nothing here stores, logs or
   * returns them anywhere else, and a second request for the same lease is refused.
   */
  async materialize(input: WorkerLeaseInput) {
    const protector = this.protector;
    if (!protector) throw new PlatformFault('capability', 'Secret materialization is not configured');
    return this.settle(async tx => {
      const held = await this.held(tx, input); if ('fault' in held) return held;
      const row = held.value.lease;
      if (row.state === 'cancelled') return { fault: new PlatformFault('conflict', 'This lease was cancelled') };
      if (row.materialized_at) return { fault: new PlatformFault('conflict', 'Secrets for this lease were already delivered') };
      const environment = (await tx`SELECT 1 FROM environments e JOIN projects p ON p.id = e.project_id AND p.org_id = e.org_id
        WHERE e.id = ${row.environment_id} AND e.project_id = ${row.project_id} AND e.org_id = ${row.org_id} AND e.state = 'active' AND p.state = 'active' FOR SHARE OF e`)[0];
      if (!environment) return { fault: new PlatformFault('conflict', 'The leased environment is not active') };
      const secrets = await tx<Row[]>`SELECT s.id, s.name, s.state, v.id AS version_id, v.version, v.wrapping_key_id, v.envelope
        FROM environment_secrets s JOIN environment_secret_versions v ON v.secret_id = s.id AND v.version = s.current_version
        WHERE s.org_id = ${row.org_id} AND s.project_id = ${row.project_id} AND s.environment_id = ${row.environment_id} AND s.name = ANY(${pgArray(row.secret_names)}::text[])
        ORDER BY s.name FOR SHARE OF s`;
      // All or nothing: a missing or disabled secret delivers no values at all.
      if (secrets.length !== row.secret_names.length || secrets.some(secret => secret.state !== 'active')) return { fault: new PlatformFault('conflict', 'A leased secret is missing or disabled') };
      const bindings = [];
      for (const secret of secrets) {
        const value = await protector.open({ wrappingKeyId: secret.wrapping_key_id, envelope: secret.envelope }, `environment-secret:${secret.id}:version:${secret.version_id}`)
          .catch(() => { throw new PlatformFault('unavailable', 'A leased secret could not be decrypted'); });
        bindings.push({ name: secret.name, version: secret.version, value });
      }
      await tx`UPDATE worker_leases SET materialized_at = now(), revision = revision + 1, updated_at = now() WHERE id = ${row.id}`;
      await this.event(tx, row.org_id, 'lease.secrets_materialized', input.requestId, { workerId: row.worker_id, leaseId: row.id },
        { secrets: secrets.map(secret => ({ name: secret.name, version: secret.version })) });
      return { value: parseComponent('WorkerSecretBindings', { leaseId: row.id, bindings, expiresAt: row.deadline_at.toISOString() }) };
    });
  }

  // ── Trusted orchestration ────────────────────────────────────────────────

  async grant(input: WorkerLeaseGrant) {
    try {
      return await this.sql.begin(async tx => {
        const scope = input.scope;
        const environment = (await tx`SELECT 1 FROM environments e JOIN projects p ON p.id = e.project_id AND p.org_id = e.org_id JOIN organizations o ON o.id = e.org_id
          WHERE e.id = ${scope.environmentId} AND e.project_id = ${scope.projectId} AND e.org_id = ${scope.orgId} AND e.state = 'active' AND p.state = 'active' AND o.state = 'active' FOR SHARE OF e`)[0];
        if (!environment) throw new PlatformFault('not_found', 'Environment not found');
        const known = await tx<{ name: string }[]>`SELECT name FROM environment_secrets WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId}
          AND environment_id = ${scope.environmentId} AND state = 'active' AND name = ANY(${pgArray(input.secretNames)}::text[])`;
        if (known.length !== input.secretNames.length) throw new PlatformFault('validation', 'A requested secret is missing or disabled in this environment');
        const row = (await tx<Row[]>`INSERT INTO worker_leases(id, org_id, project_id, environment_id, purpose, subject_id, max_attempts, secret_names, required_platform, expires_at, deadline_at)
          VALUES (${input.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${input.purpose}, ${input.subjectId}, ${input.maxAttempts}, ${pgArray(input.secretNames)}::text[],
            ${input.requiredPlatform ?? null}, now() + make_interval(secs => ${Math.min(input.claimSeconds, input.deadlineSeconds)}), now() + make_interval(secs => ${input.deadlineSeconds}))
          RETURNING *, revision::text`)[0]!;
        await this.event(tx, scope.orgId, 'lease.granted', input.requestId, { leaseId: row.id }, { purpose: input.purpose, subjectId: input.subjectId, secretNames: input.secretNames, attempt: 1 });
        return lease(row);
      });
    } catch (error) {
      if (error instanceof PlatformFault) throw error;
      if ((error as { errno?: string }).errno === '23505') throw new PlatformFault('conflict', 'This subject already has a lease');
      throw error;
    }
  }

  async cancel(subjectId: string, requestId: string) {
    return this.sql.begin(async tx => {
      const rows = await tx<Row[]>`UPDATE worker_leases SET state = 'cancelled', lease_token_hash = NULL, revision = revision + 1, updated_at = now()
        WHERE subject_id = ${subjectId} AND state IN ('granted', 'claimed') RETURNING *, revision::text`;
      for (const row of rows) await this.event(tx, row.org_id, 'lease.cancelled', requestId, { workerId: row.worker_id, leaseId: row.id });
      return rows.map(lease);
    });
  }

  /** Sweeps leases whose window passed. Returns the successor leases created for lost workers. */
  async reclaim(requestId: string, limit: number) {
    return this.sql.begin(async tx => {
      const rows = await tx<Row[]>`SELECT *, revision::text FROM worker_leases WHERE state IN ('granted', 'claimed') AND expires_at <= now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      const successors: WorkerLease[] = [];
      // An offer nobody claimed simply lapses; only a lease a worker held and lost is retried.
      for (const row of rows) { const next = await this.expire(tx, row, requestId, row.state === 'claimed'); if (next) successors.push(lease(next)); }
      return successors;
    });
  }
}
