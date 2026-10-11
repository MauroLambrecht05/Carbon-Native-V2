import { randomUUID } from 'node:crypto';
import type { ServiceErasureReceipt } from '@carbon/contracts/platform';
import type { ErasureRepository, ErasureWork } from '../application/ports/EnvironmentErasure.ts';

type Row = Record<string, any>;

/** Cloud's record of what must be erased in the owning services, and of what was. */
export class PostgresErasureRepository implements ErasureRepository {
  constructor(private readonly sql: Bun.SQL) {}

  async claim(limit: number): Promise<readonly ErasureWork[]> {
    // Taking an erasure pushes its next attempt out, doubling each time up to an hour. That is both the retry
    // backoff and the claim: nobody else sees it as due while this delivery runs.
    const rows = await this.sql<Row[]>`UPDATE environment_erasures SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, least(attempts, 6))::integer))
      WHERE id IN (SELECT r.id FROM environment_erasures r WHERE r.state = 'pending' AND r.next_attempt_at <= now()
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.org_id = r.org_id AND h.released_at IS NULL) ORDER BY r.next_attempt_at FOR UPDATE OF r SKIP LOCKED LIMIT ${limit})
      RETURNING id, org_id, project_id, environment_id, binding_id, owner, remote_resource_id, attempts`;
    return rows.map(row => ({ erasureId: row.id, scope: { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id }, owner: row.owner, bindingId: row.binding_id,
      remoteResourceId: row.remote_resource_id, attempt: row.attempts }));
  }

  async complete(work: ErasureWork, receipt: ServiceErasureReceipt, requestId: string): Promise<boolean> {
    return this.sql.begin(async tx => {
      const updated = await tx`UPDATE environment_erasures SET state = 'erased', completed_at = now(), last_error = NULL, receipt = ${JSON.stringify(receipt)}::text::jsonb
        WHERE id = ${work.erasureId} AND state = 'pending' RETURNING id`;
      if (!updated.length) return false;
      await tx`INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, action, resource_kind, resource_id, request_id)
        VALUES (${randomUUID()}, 'catalog', ${work.scope.orgId}, ${work.scope.projectId}, ${work.scope.environmentId}, 'system', ${`environment.erased.${work.owner}`}, 'environment', ${work.scope.environmentId}, ${requestId})`;
      return true;
    });
  }

  async fail(work: ErasureWork, category: string): Promise<void> {
    await this.sql`UPDATE environment_erasures SET last_error = ${/^[a-z][a-z0-9_.-]{0,99}$/.test(category) ? category : 'erasure.unavailable'} WHERE id = ${work.erasureId} AND state = 'pending'`;
  }
}
