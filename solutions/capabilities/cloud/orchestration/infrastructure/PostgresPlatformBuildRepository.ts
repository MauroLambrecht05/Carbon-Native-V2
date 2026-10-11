import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_PLAN, PLANS, type PlanId } from '@carbon/billing';
import type { HeldLease, LeaseOutcome, PostgresWorkerRepository, WorkerLeaseInput } from '@carbon/catalog';
import {
  PlatformFault, parseComponent, type Build, type BuildArtifact, type BuildArtifactDeclare, type BuildLogAppend, type BuildLogSegment, type BuildSource, type EnvironmentScope,
  type BuildProvenance, type WorkerBuildComplete,
} from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import type { BuildCancellation, BuildCreation, PlatformBuildRepository, ProvenanceSigner } from '../application/ports/PlatformBuildRepository.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
/** Minutes reserved against quota for one build; also its hard deadline. */
const RESERVED_MINUTES = 30;
const MAX_ATTEMPTS = 3;
const MAX_LOG_SEGMENTS = 5000;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
/** Credentials this platform issues. A log line that contains one is stored without it. */
const CREDENTIAL = /\b(?:cc|wk|dc|dv|cs|ce|pt|wc|wl|we|aps|am|ao|as|ac|ec|inv|csrf)_[A-Za-z0-9_-]{20,}/g;

function scopeOf(row: Row): EnvironmentScope { return { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id }; }
function build(row: Row): Build {
  return parseComponent('Build', {
    id: row.id, scope: scopeOf(row), state: row.state, source: row.source, sourceDigest: row.source_digest, attempt: row.attempt, createdBy: row.created_by,
    reservedMinutes: row.reserved_minutes, usedMinutes: row.used_minutes ?? null, errorCategory: row.error_category ?? null, revision: row.revision,
    createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null,
  });
}
function artifact(row: Row): BuildArtifact {
  return parseComponent('BuildArtifact', { id: row.id, attempt: row.number, target: row.target, objectKey: row.object_key, sizeBytes: Number(row.size_bytes), sha256: row.sha256, createdAt: row.created_at.toISOString() });
}

export class PostgresPlatformBuildRepository extends PostgresPlatformAuthority implements PlatformBuildRepository {
  constructor(sql: Bun.SQL, private readonly workers: PostgresWorkerRepository, private readonly signer?: ProvenanceSigner) { super(sql); }

  private event(tx: Tx, row: Row, action: string, requestId: string, ids: { accountId?: string | null; workerId?: string | null } = {}) {
    return tx`INSERT INTO build_events (id, org_id, project_id, environment_id, build_id, actor_account_id, worker_id, action, revision, request_id)
      VALUES (${randomUUID()}, ${row.org_id}, ${row.project_id}, ${row.environment_id}, ${row.id}, ${ids.accountId ?? null}, ${ids.workerId ?? null}, ${action}, ${row.revision}, ${requestId})`;
  }
  private async authorize(tx: Tx, input: OrganizationActor, scope: EnvironmentScope, permission: 'metadata.read' | 'release.publish') {
    await this.lockAccounts(tx, [input.accountId], true); const current = await this.actor(tx, input);
    const actor = { ...input, permissionRevision: current.permission_revision as string };
    const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes(permission)) throw new PlatformFault('forbidden', permission === 'metadata.read' ? 'Reading builds is not permitted' : 'Starting builds is not permitted');
    return { actor, permissions: access.permissions };
  }
  private async row(tx: Tx, scope: EnvironmentScope, id: string, lock = false): Promise<Row> {
    const rows = lock
      ? await tx<Row[]>`SELECT *, revision::text FROM platform_builds WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`
      : await tx<Row[]>`SELECT *, revision::text FROM platform_builds WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}`;
    if (!rows.length) throw new PlatformFault('not_found', 'Build not found');
    return rows[0]!;
  }

  /**
   * Ends a build: closes its running attempt, settles quota from the time attempts actually ran, and records usage.
   * The reservation is released by the build leaving the open states; nothing else holds it.
   */
  private async finish(tx: Tx, row: Row, state: 'succeeded' | 'failed' | 'cancelled', attemptState: 'succeeded' | 'failed' | 'lost' | 'cancelled', errorCategory: string | null,
    requestId: string, ids: { accountId?: string | null; workerId?: string | null } = {}): Promise<Row> {
    await tx`UPDATE build_attempts SET state = ${attemptState}, ended_at = now() WHERE build_id = ${row.id} AND state = 'running'`;
    const elapsed = (await tx<{ ms: string }[]>`SELECT COALESCE(sum(extract(epoch from (ended_at - started_at)) * 1000), 0)::bigint::text AS ms FROM build_attempts WHERE build_id = ${row.id}`)[0]!.ms;
    const usedMinutes = Math.min(row.reserved_minutes, Math.ceil(Number(elapsed) / 60_000));
    const updated = (await tx<Row[]>`UPDATE platform_builds SET state = ${state}, used_minutes = ${usedMinutes}, error_category = ${errorCategory}, completed_at = now(), revision = revision + 1
      WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
    if (usedMinutes > 0) await tx`INSERT INTO usage_records (id, org_id, build_id, duration_ms) VALUES (${randomUUID()}, ${row.org_id}, ${row.id}, ${usedMinutes * 60_000})`;
    // The same fact in the meter every charged thing shares. The build names it, so it is counted once.
    if (usedMinutes > 0) await tx`INSERT INTO usage_events (id, org_id, meter, quantity, source_key) VALUES (${randomUUID()}, ${row.org_id}, 'build_minutes', ${usedMinutes}, ${`build:${row.id}`}) ON CONFLICT (source_key) DO NOTHING`;
    await this.event(tx, updated, `build.${state}`, requestId, ids);
    return updated;
  }

  // ── Developers ───────────────────────────────────────────────────────────

  async create(input: BuildCreation) {
    try {
      return await this.sql.begin(async tx => {
        const scope = input.scope;
        // Reservations for one organization are serialized so two builds cannot both take the last minutes.
        await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR UPDATE`;
        const { actor } = await this.authorize(tx, input.actor, scope, 'release.publish');
        const key = `builds:${scope.environmentId}`;
        const old = (await tx`SELECT request_digest, result FROM build_commands WHERE actor_account_id = ${actor.accountId} AND scope_key = ${key} AND key_digest = ${input.keyDigest}`)[0];
        if (old) { if (old.request_digest !== input.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command'); return parseComponent('BuildReceipt', old.result); }
        if (input.source.repositoryId && !(await tx`SELECT 1 FROM project_repository_configs WHERE repository_id = ${input.source.repositoryId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId}`).length) {
          throw new PlatformFault('validation', 'The repository is not connected to this project');
        }
        const plan = ((await tx<{ plan: PlanId }[]>`SELECT plan FROM org_plans WHERE org_id = ${scope.orgId}`)[0]?.plan ?? DEFAULT_PLAN);
        const included = (PLANS[plan] ?? PLANS[DEFAULT_PLAN]).includedBuildMinutesPerMonth;
        const used = Number((await tx<{ minutes: string }[]>`SELECT COALESCE(ceil(sum(duration_ms) / 60000.0), 0)::bigint::text AS minutes FROM usage_records
          WHERE org_id = ${scope.orgId} AND recorded_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`)[0]!.minutes);
        const reserved = Number((await tx<{ minutes: string }[]>`SELECT COALESCE(sum(reserved_minutes), 0)::bigint::text AS minutes FROM platform_builds WHERE org_id = ${scope.orgId} AND state IN ('queued', 'running')`)[0]!.minutes);
        if (used + reserved + RESERVED_MINUTES > included) throw new PlatformFault('quota', 'This organization has no build minutes left this month', { quota: 'build_minutes' });
        // The organization's own budget, if it set one, inside what the plan includes.
        const budget = (await tx<{ monthly_limit: string; mode: string }[]>`SELECT monthly_limit::text, mode FROM usage_budgets WHERE org_id = ${scope.orgId} AND meter = 'build_minutes'`)[0];
        if (budget?.mode === 'cap' && used + reserved + RESERVED_MINUTES > Number(budget.monthly_limit)) throw new PlatformFault('quota', 'This organization has reached the budget it set for build minutes this month', { quota: 'build_minutes', budget: 'cap' });
        const row = (await tx<Row[]>`INSERT INTO platform_builds (id, org_id, project_id, environment_id, source, source_digest, created_by, reserved_minutes, deadline_at, request_id)
          VALUES (${input.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${JSON.stringify(input.source)}::text::jsonb, ${input.sourceDigest}, ${actor.accountId}, ${RESERVED_MINUTES},
            now() + make_interval(mins => ${RESERVED_MINUTES}), ${input.requestId}) RETURNING *, revision::text`)[0]!;
        // The lease is the build's only way to reach a worker and its secrets; it commits with the build or not at all.
        await this.workers.grantIn(tx, { id: input.leaseId, scope, purpose: 'build', subjectId: row.id, secretNames: input.source.secretNames, requiredPlatform: input.source.platform,
          claimSeconds: RESERVED_MINUTES * 60, deadlineSeconds: RESERVED_MINUTES * 60, maxAttempts: MAX_ATTEMPTS, requestId: input.requestId });
        const receipt = parseComponent('BuildReceipt', { build: build(row), message: 'Build queued' });
        await tx`INSERT INTO build_commands VALUES (${actor.accountId}, ${key}, ${input.keyDigest}, ${input.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
        await this.event(tx, row, 'build.queued', input.requestId, { accountId: actor.accountId });
        return receipt;
      });
    } catch (error) {
      if (error instanceof PlatformFault) throw error;
      if ((error as { errno?: string }).errno === '23505') throw new PlatformFault('conflict', 'This build already exists');
      throw error;
    }
  }

  async list(input: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const rows = await tx<Row[]>`SELECT *, revision::text FROM platform_builds WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
        AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${limit}`;
      return rows.map(build);
    });
  }

  async get(input: OrganizationActor, scope: EnvironmentScope, id: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const row = await this.row(tx, scope, id);
      // A build's outputs are those of the attempt that succeeded; a lost attempt's declarations are not outputs.
      const artifacts = await tx<Row[]>`SELECT f.*, a.number FROM build_artifacts f JOIN build_attempts a ON a.id = f.attempt_id WHERE f.build_id = ${row.id} AND a.state = 'succeeded' ORDER BY f.target`;
      return parseComponent('BuildDetails', { build: build(row), artifacts: artifacts.map(artifact) });
    });
  }

  async logs(input: OrganizationActor, scope: EnvironmentScope, id: string, after: number, limit: number) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const row = await this.row(tx, scope, id);
      const rows = await tx<Row[]>`SELECT s.sequence, s.content, s.created_at, a.number FROM build_log_segments s JOIN build_attempts a ON a.id = s.attempt_id
        WHERE s.build_id = ${row.id} AND s.sequence > ${after} ORDER BY s.sequence LIMIT ${limit}`;
      return rows.map((segment): BuildLogSegment => parseComponent('BuildLogSegment', { sequence: segment.sequence, attempt: segment.number, text: segment.content, createdAt: segment.created_at.toISOString() }));
    });
  }

  async cancel(input: BuildCancellation) {
    return this.sql.begin(async tx => {
      const { actor, permissions } = await this.authorize(tx, input.actor, input.scope, 'metadata.read');
      const row = await this.row(tx, input.scope, input.buildId, true);
      if (row.created_by !== actor.accountId && !permissions.includes('build.cancel.any')) throw new PlatformFault('forbidden', 'Only the build creator or a member who may cancel any build can cancel this build');
      const key = `build:${row.id}`;
      const old = (await tx`SELECT request_digest, result FROM build_commands WHERE actor_account_id = ${actor.accountId} AND scope_key = ${key} AND key_digest = ${input.keyDigest}`)[0];
      if (old) { if (old.request_digest !== input.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command'); return parseComponent('BuildReceipt', old.result); }
      if (row.revision !== input.expectedRevision) throw new PlatformFault('conflict', 'The build changed; refresh before retrying');
      if (!['queued', 'running'].includes(row.state)) throw new PlatformFault('conflict', 'This build is already finished');
      // The lease goes first: from here the worker can neither read secrets nor report success.
      await this.workers.cancelIn(tx, row.id, input.requestId);
      const updated = await this.finish(tx, row, 'cancelled', 'cancelled', 'cancelled', input.requestId, { accountId: actor.accountId });
      const receipt = parseComponent('BuildReceipt', { build: build(updated), message: 'Build cancelled' });
      await tx`INSERT INTO build_commands VALUES (${actor.accountId}, ${key}, ${input.keyDigest}, ${input.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
      return receipt;
    });
  }

  // ── The worker that holds the build's lease ──────────────────────────────

  /** The build a held lease is for, locked. Only a build lease for an open build gets past this. */
  private async leased(tx: Tx, held: HeldLease): Promise<LeaseOutcome<{ row: Row; attempt?: Row }>> {
    if (held.lease.purpose !== 'build') return { fault: new PlatformFault('not_found', 'This lease is not for a build') };
    const row = (await tx<Row[]>`SELECT *, revision::text FROM platform_builds WHERE id = ${held.lease.subject_id} FOR UPDATE`)[0];
    if (!row) return { fault: new PlatformFault('not_found', 'Build not found') };
    if (!['queued', 'running'].includes(row.state)) return { fault: new PlatformFault('conflict', 'This build is already finished') };
    const attempt = (await tx<Row[]>`SELECT * FROM build_attempts WHERE lease_id = ${held.lease.id}`)[0];
    return { value: { row, attempt } };
  }
  private async started(tx: Tx, held: HeldLease): Promise<LeaseOutcome<{ row: Row; attempt: Row }>> {
    const leased = await this.leased(tx, held); if ('fault' in leased) return leased;
    if (!leased.value.attempt || leased.value.attempt.state !== 'running') return { fault: new PlatformFault('conflict', 'Fetch the build input before reporting on it') };
    return { value: { row: leased.value.row, attempt: leased.value.attempt } };
  }

  async input(lease: WorkerLeaseInput) {
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const leased = await this.leased(tx, held); if ('fault' in leased) return leased;
      let { row, attempt } = leased.value;
      if (!attempt) {
        // A new lease for the same build means the previous worker was lost.
        await tx`UPDATE build_attempts SET state = 'lost', ended_at = now() WHERE build_id = ${row.id} AND state = 'running'`;
        attempt = (await tx<Row[]>`INSERT INTO build_attempts (id, build_id, number, lease_id, worker_id) VALUES (${randomUUID()}, ${row.id}, ${held.lease.attempt}, ${held.lease.id}, ${held.worker.id}) RETURNING *`)[0]!;
        row = (await tx<Row[]>`UPDATE platform_builds SET state = 'running', attempt = ${held.lease.attempt}, started_at = COALESCE(started_at, now()), revision = revision + 1 WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
        await this.event(tx, row, 'build.attempt_started', lease.requestId, { workerId: held.worker.id });
      }
      const next = (await tx<{ next: number }[]>`SELECT COALESCE(max(sequence), 0) + 1 AS next FROM build_log_segments WHERE build_id = ${row.id}`)[0]!.next;
      return { value: parseComponent('WorkerBuildInput', { buildId: row.id, scope: scopeOf(row), source: row.source as BuildSource, sourceDigest: row.source_digest, attempt: attempt.number, nextLogSequence: next }) };
    });
  }

  async appendLog(lease: WorkerLeaseInput, segment: BuildLogAppend) {
    const content = segment.text.replace(CREDENTIAL, '[redacted]'); const digest = createHash('sha256').update(content).digest('hex');
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const started = await this.started(tx, held); if ('fault' in started) return started;
      const { row, attempt } = started.value;
      const totals = (await tx<{ last: number; segments: number; bytes: string }[]>`SELECT COALESCE(max(sequence), 0) AS last, count(*)::integer AS segments, COALESCE(sum(octet_length(content)), 0)::bigint::text AS bytes
        FROM build_log_segments WHERE build_id = ${row.id}`)[0]!;
      if (segment.sequence <= totals.last) {
        // A retry of a segment that was already stored is accepted only if it is the same segment.
        const existing = (await tx`SELECT content_digest FROM build_log_segments WHERE build_id = ${row.id} AND sequence = ${segment.sequence}`)[0];
        if (existing?.content_digest === digest) return { value: { nextLogSequence: totals.last + 1 } };
        return { fault: new PlatformFault('conflict', 'This log sequence was already written with different content') };
      }
      if (segment.sequence !== totals.last + 1) return { fault: new PlatformFault('conflict', 'Log segments must be appended in order') };
      if (totals.segments >= MAX_LOG_SEGMENTS || Number(totals.bytes) + Buffer.byteLength(content) > MAX_LOG_BYTES) return { fault: new PlatformFault('quota', 'This build has reached its log limit') };
      await tx`INSERT INTO build_log_segments (build_id, sequence, attempt_id, content, content_digest) VALUES (${row.id}, ${segment.sequence}, ${attempt.id}, ${content}, ${digest})`;
      return { value: { nextLogSequence: segment.sequence + 1 } };
    });
  }

  async declareArtifact(lease: WorkerLeaseInput, declared: BuildArtifactDeclare) {
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const started = await this.started(tx, held); if ('fault' in started) return started;
      const { row, attempt } = started.value;
      if (!(row.source.targets as string[]).includes(declared.target)) return { fault: new PlatformFault('validation', 'This build does not produce that target') };
      // An artifact lives under its own build and attempt, so one build can never claim another's object.
      if (!declared.objectKey.startsWith(`artifacts/${row.id}/${attempt.number}/`)) return { fault: new PlatformFault('validation', 'The artifact key must be under this build attempt') };
      const existing = (await tx<Row[]>`SELECT f.*, ${attempt.number}::integer AS number FROM build_artifacts f WHERE f.attempt_id = ${attempt.id} AND f.target = ${declared.target}`)[0];
      if (existing) {
        if (existing.object_key === declared.objectKey && Number(existing.size_bytes) === declared.sizeBytes && existing.sha256 === declared.sha256) return { value: artifact(existing) };
        return { fault: new PlatformFault('conflict', 'This target was already declared with a different artifact') };
      }
      const created = (await tx<Row[]>`INSERT INTO build_artifacts (id, build_id, attempt_id, target, object_key, size_bytes, sha256)
        VALUES (${randomUUID()}, ${row.id}, ${attempt.id}, ${declared.target}, ${declared.objectKey}, ${declared.sizeBytes}, ${declared.sha256}) RETURNING *`)[0]!;
      return { value: artifact({ ...created, number: attempt.number }) };
    });
  }

  async declared(lease: WorkerLeaseInput) {
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const started = await this.started(tx, held); if ('fault' in started) return started;
      const rows = await tx<Row[]>`SELECT f.*, ${started.value.attempt.number}::integer AS number FROM build_artifacts f WHERE f.attempt_id = ${started.value.attempt.id} ORDER BY f.target`;
      return { value: rows.map(artifact) };
    });
  }

  async complete(lease: WorkerLeaseInput, result: WorkerBuildComplete) {
    return this.workers.withHeldLease(lease, async (tx, held) => {
      const started = await this.started(tx, held); if ('fault' in started) return started;
      const { row, attempt } = started.value;
      if (result.outcome === 'succeeded') {
        const declared = (await tx<{ target: string }[]>`SELECT target FROM build_artifacts WHERE attempt_id = ${attempt.id}`).map(item => item.target);
        if ((row.source.targets as string[]).some(target => !declared.includes(target))) return { fault: new PlatformFault('conflict', 'Every target needs a declared artifact before the build can succeed') };
        // The worker must have built the commit it was given.
        if (result.materials.resolvedCommit !== row.source.commitSha) return { fault: new PlatformFault('conflict', 'The built commit does not match the build input') };
      }
      await this.workers.completeIn(tx, held.lease, lease.requestId);
      if (result.outcome === 'succeeded') await this.attest(tx, row, attempt, held.worker.id, result.materials);
      const updated = result.outcome === 'succeeded'
        ? await this.finish(tx, row, 'succeeded', 'succeeded', null, lease.requestId, { workerId: held.worker.id })
        // A failure the worker reports is the build's own failure and is not retried; only a lost worker is.
        : await this.finish(tx, row, 'failed', 'failed', result.errorCategory, lease.requestId, { workerId: held.worker.id });
      return { value: build(updated) };
    });
  }

  /** Records what was built, from what, and the verified outputs, in a fixed key order so the digest and signature are reproducible. */
  private async attest(tx: Tx, row: Row, attempt: Row, workerId: string, materials: Extract<WorkerBuildComplete, { outcome: 'succeeded' }>['materials']) {
    const artifacts = await tx<Row[]>`SELECT target, object_key, size_bytes, sha256 FROM build_artifacts WHERE attempt_id = ${attempt.id} ORDER BY target`;
    const source = row.source as BuildSource;
    const statement = {
      version: 1 as const, buildId: row.id as string, scope: scopeOf(row), attempt: attempt.number as number, workerId,
      source: { commitSha: source.commitSha, platform: source.platform, ...(source.repositoryId ? { repositoryId: source.repositoryId } : {}), repositoryUrl: source.repositoryUrl, secretNames: source.secretNames, targets: source.targets },
      sourceDigest: row.source_digest as string,
      materials: { resolvedCommit: materials.resolvedCommit, dependencyLockDigest: materials.dependencyLockDigest, configurationDigest: materials.configurationDigest,
        tools: [...materials.tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({ name: tool.name, version: tool.version })), workspaceErased: materials.workspaceErased },
      artifacts: artifacts.map(item => ({ target: item.target as string, objectKey: item.object_key as string, sizeBytes: Number(item.size_bytes), sha256: item.sha256 as string })),
      startedAt: (attempt.started_at as Date).toISOString(), finishedAt: new Date().toISOString(),
    };
    const canonical = JSON.stringify(statement); const digest = createHash('sha256').update(canonical).digest('hex');
    await tx`INSERT INTO build_provenance (build_id, attempt_id, statement, statement_digest, canonical_statement, key_id, signature)
      VALUES (${row.id}, ${attempt.id}, ${canonical}::text::jsonb, ${digest}, ${canonical}, ${this.signer?.keyId ?? null}, ${this.signer ? this.signer.sign(canonical) : null})`;
  }

  async provenance(input: OrganizationActor, scope: EnvironmentScope, id: string): Promise<BuildProvenance> {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const row = await this.row(tx, scope, id);
      const record = (await tx<Row[]>`SELECT canonical_statement, statement_digest, key_id, signature FROM build_provenance WHERE build_id = ${row.id}`)[0];
      if (!record) throw new PlatformFault('not_found', 'This build has no provenance');
      // The stored canonical text is returned as written: re-serializing could change the bytes the signature covers.
      return parseComponent('BuildProvenance', { statement: JSON.parse(record.canonical_statement), statementDigest: record.statement_digest,
        signature: record.signature ? { keyId: record.key_id, algorithm: 'ed25519', value: record.signature } : null });
    });
  }

  // ── Cloud's own timer ────────────────────────────────────────────────────

  /**
   * Fails open builds that can no longer make progress: no lease is offered or held for them any more (the worker
   * was lost on the last allowed attempt, or nobody claimed the build), or the deadline passed.
   */
  async reconcile(requestId: string, limit: number) {
    return this.sql.begin(async tx => {
      const rows = await tx<Row[]>`SELECT b.*, b.revision::text FROM platform_builds b WHERE b.state IN ('queued', 'running')
        AND (b.deadline_at <= now() OR NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.subject_id = b.id AND l.state IN ('granted', 'claimed') AND l.expires_at > now()))
        ORDER BY b.created_at FOR UPDATE OF b SKIP LOCKED LIMIT ${limit}`;
      const finished: Build[] = [];
      for (const row of rows) {
        // A lease that is merely overdue still gets its retry from the lease sweeper first.
        if (row.deadline_at > new Date() && (await tx`SELECT 1 FROM worker_leases WHERE subject_id = ${row.id} AND state IN ('granted', 'claimed')`).length) continue;
        await this.workers.cancelIn(tx, row.id, requestId);
        const category = row.deadline_at <= new Date() ? 'deadline_exceeded' : row.attempt > 0 ? 'worker_lost' : 'no_worker';
        finished.push(build(await this.finish(tx, row, 'failed', 'lost', category, requestId)));
      }
      return finished;
    });
  }
}
