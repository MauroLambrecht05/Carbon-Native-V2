import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type AuditEntry, type Scope } from '@carbon/contracts/platform';
import type { AuditLog, AuditPosition, AuditSlice, OrganizationLifecycleStore } from '../application/ports/AuditLog.ts';
import type { OrganizationActor } from '../application/ports/OrganizationRepository.ts';
import { PostgresPlatformAuthority } from './PostgresPlatformAuthority.ts';

function entry(row: Record<string, any>): AuditEntry {
  return parseComponent('AuditEntry', {
    id: row.id, sequence: row.sequence, action: row.action, occurredAt: row.occurred_at.toISOString(), requestId: row.request_id,
    scope: { orgId: row.org_id, ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.environment_id ? { environmentId: row.environment_id } : {}) },
    resource: { owner: 'cloud', kind: row.resource_kind, id: row.resource_id }, actor: { kind: row.actor_kind, id: row.actor_id ?? null },
    ...(row.revision ? { revision: row.revision } : {}),
  });
}

/**
 * Reads the organization event log. Every read re-resolves the caller's current access, so a revoked member,
 * a changed role or an ended session stops seeing events on the next read.
 */
export class PostgresAuditLog extends PostgresPlatformAuthority implements AuditLog, OrganizationLifecycleStore {
  private async authorize(tx: Bun.TransactionSQL, actor: OrganizationActor, scope: Scope) {
    if (scope.realmId) throw new PlatformFault('validation', 'Audit events are not scoped to an application realm');
    const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes('audit.read')) throw new PlatformFault('forbidden', 'Reading audit events is not permitted');
  }
  // Only events below the oldest running transaction are visible: nothing older can still commit beneath them.
  private before(tx: Bun.TransactionSQL, scope: Scope, bound: AuditPosition | undefined, limit: number) {
    return tx<Record<string, any>[]>`SELECT id, sequence::text, transaction_id::text AS transaction, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision::text, request_id, occurred_at
      FROM platform_events WHERE org_id = ${scope.orgId} AND transaction_id < pg_snapshot_xmin(pg_current_snapshot())
        AND (${scope.projectId ?? null}::uuid IS NULL OR project_id = ${scope.projectId ?? null}::uuid)
        AND (${scope.environmentId ?? null}::uuid IS NULL OR environment_id = ${scope.environmentId ?? null}::uuid)
        AND (${bound?.transaction ?? null}::text IS NULL OR (transaction_id, sequence) < (${bound?.transaction ?? '0'}::xid8, ${bound?.sequence ?? '0'}::bigint))
      ORDER BY transaction_id DESC, sequence DESC LIMIT ${limit}`;
  }
  private after(tx: Bun.TransactionSQL, scope: Scope, bound: AuditPosition, limit: number) {
    return tx<Record<string, any>[]>`SELECT id, sequence::text, transaction_id::text AS transaction, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision::text, request_id, occurred_at
      FROM platform_events WHERE org_id = ${scope.orgId} AND transaction_id < pg_snapshot_xmin(pg_current_snapshot())
        AND (${scope.projectId ?? null}::uuid IS NULL OR project_id = ${scope.projectId ?? null}::uuid)
        AND (${scope.environmentId ?? null}::uuid IS NULL OR environment_id = ${scope.environmentId ?? null}::uuid)
        AND (transaction_id, sequence) > (${bound.transaction}::xid8, ${bound.sequence}::bigint)
      ORDER BY transaction_id, sequence LIMIT ${limit}`;
  }
  private slice(rows: Record<string, any>[]): AuditSlice {
    return { entries: rows.map(entry), positions: rows.map(row => ({ transaction: row.transaction, sequence: row.sequence })) };
  }

  /** Newest first, for browsing. */
  async browse(actor: OrganizationActor, scope: Scope, limit: number, before?: AuditPosition): Promise<AuditSlice> {
    return this.sql.begin(async tx => { await this.authorize(tx, actor, scope); return this.slice(await this.before(tx, scope, before, limit)); });
  }
  /** Oldest first after a position, for following the log. */
  async follow(actor: OrganizationActor, scope: Scope, limit: number, after: AuditPosition): Promise<AuditSlice> {
    return this.sql.begin(async tx => { await this.authorize(tx, actor, scope); return this.slice(await this.after(tx, scope, after, limit)); });
  }
  /** The position a new follower starts from: everything already visible is behind it. */
  async head(actor: OrganizationActor, scope: Scope): Promise<AuditPosition> {
    return this.sql.begin(async tx => {
      await this.authorize(tx, actor, scope);
      const row = (await tx<{ transaction: string }[]>`SELECT (pg_snapshot_xmin(pg_current_snapshot())::text::numeric - 1)::text AS transaction`)[0]!;
      return { transaction: row.transaction, sequence: '9223372036854775807' };
    });
  }

  // ── Organization lifecycle driven by Cloud itself (operators, timers). No HTTP route reaches these. ──

  private async system(tx: Bun.TransactionSQL, orgId: string, action: string, requestId: string) {
    const revision = (await tx<{ revision: string }[]>`UPDATE organizations SET revision = revision + 1 WHERE id = ${orgId} RETURNING revision::text`)[0]!.revision;
    await tx`INSERT INTO platform_events (id, source, org_id, actor_kind, action, resource_kind, resource_id, revision, request_id)
      VALUES (${randomUUID()}, 'system', ${orgId}, 'system', ${action}, 'organization', ${orgId}, ${revision}, ${requestId})`;
  }
  async suspend(orgId: string, reasonCode: string, requestId: string) {
    return this.sql.begin(async tx => {
      const row = (await tx`SELECT state FROM organizations WHERE id = ${orgId} AND human_managed FOR UPDATE`)[0];
      if (!row) throw new PlatformFault('not_found', 'Organization not found');
      if (row.state !== 'active') throw new PlatformFault('conflict', 'Only an active organization can be suspended');
      await tx`UPDATE organizations SET state = 'suspended', suspension_reason = ${reasonCode} WHERE id = ${orgId}`;
      await this.system(tx, orgId, 'organization.suspended', requestId);
    });
  }
  async reinstate(orgId: string, requestId: string) {
    return this.sql.begin(async tx => {
      const row = (await tx`SELECT state FROM organizations WHERE id = ${orgId} AND human_managed FOR UPDATE`)[0];
      if (!row) throw new PlatformFault('not_found', 'Organization not found');
      if (row.state !== 'suspended') throw new PlatformFault('conflict', 'This organization is not suspended');
      await tx`UPDATE organizations SET state = 'active', suspension_reason = NULL WHERE id = ${orgId}`;
      await this.system(tx, orgId, 'organization.reinstated', requestId);
    });
  }
  /**
   * Makes due organization deletions final. Rows are kept and marked deleted. An organization under a legal hold, or
   * with a subscription the provider may still charge, is left pending however long its window has been over.
   */
  async finalizeDeletions(requestId: string, limit: number): Promise<readonly string[]> {
    return this.sql.begin(async tx => {
      const rows = await tx<{ id: string }[]>`SELECT o.id FROM organizations o WHERE o.state = 'deletion_pending' AND o.deletion_scheduled_at <= now()
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.org_id = o.id AND h.released_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.org_id = o.id AND s.state IN ('active', 'past_due', 'cancel_scheduled'))
        ORDER BY o.deletion_scheduled_at FOR UPDATE OF o SKIP LOCKED LIMIT ${limit}`;
      for (const row of rows) {
        // The active-owner rule applies to managed organizations only; a deleted one keeps its memberships for the record.
        await tx`UPDATE organizations SET state = 'deleted', deletion_scheduled_at = NULL WHERE id = ${row.id}`;
        await this.system(tx, row.id, 'organization.deleted', requestId);
      }
      return rows.map(row => row.id);
    });
  }
}
