import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type OperatorApproval, type OperatorCommand, type OperatorOrganization, type OperatorReceipt, type OperatorRole } from '@carbon/contracts/platform';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
export interface OperatorIdentity { readonly id: string; readonly roles: readonly OperatorRole[] }
/** Which role each command needs. An operator without it is refused, whatever else they hold. */
const REQUIRED: Record<OperatorCommand['kind'], readonly OperatorRole[]> = {
  suspend: ['support', 'security'], reinstate: ['support', 'security'], 'hold-place': ['security'], 'hold-release': ['security'],
  'delete-now-request': ['recovery'], 'delete-now-approve': ['recovery'], 'delete-now-reject': ['recovery'],
};
const APPROVAL_HOURS = 24;
const BILLABLE = ['active', 'past_due', 'cancel_scheduled'];

function approvalView(row: Row): OperatorApproval {
  return parseComponent('OperatorApproval', { id: row.id, action: row.action, orgId: row.org_id, requestedBy: row.requested_by, reason: row.reason, state: row.state, expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString() });
}

/**
 * What Cloud's operators can do, and the record of it. Operators are their own accounts: nothing here reads a
 * customer session, grants a membership, or returns anything of a customer's projects or data.
 */
export class PostgresOperators {
  constructor(private readonly sql: Bun.SQL) {}

  // ── Administration. No route leads here; it is run by whoever administers Cloud itself. ──

  async create(email: string, name: string, roles: readonly OperatorRole[]): Promise<string> {
    const id = randomUUID();
    await this.sql.begin(async tx => {
      await tx`INSERT INTO operators (id, email, name) VALUES (${id}, ${email.toLowerCase()}, ${name})`;
      for (const role of new Set(roles)) await tx`INSERT INTO operator_roles (operator_id, role) VALUES (${id}, ${parseComponent('OperatorRole', role)})`;
    });
    return id;
  }
  async credential(operatorId: string, tokenHash: string, hours: number): Promise<void> {
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) throw new PlatformFault('validation', 'An operator credential lasts between one hour and thirty days');
    await this.sql`INSERT INTO operator_credentials (id, operator_id, token_hash, expires_at) VALUES (${randomUUID()}, ${operatorId}, ${tokenHash}, now() + make_interval(hours => ${hours}))`;
  }
  async disable(operatorId: string): Promise<void> {
    await this.sql.begin(async tx => { await tx`UPDATE operators SET state = 'disabled' WHERE id = ${operatorId}`; await tx`UPDATE operator_credentials SET revoked_at = now() WHERE operator_id = ${operatorId} AND revoked_at IS NULL`; });
  }

  // ── Authenticated operators ──

  private async authenticate(tx: Tx, tokenHash: string): Promise<OperatorIdentity> {
    const row = (await tx<Row[]>`SELECT o.id FROM operator_credentials c JOIN operators o ON o.id = c.operator_id
      WHERE c.token_hash = ${tokenHash} AND c.revoked_at IS NULL AND c.expires_at > now() AND o.state = 'active' FOR SHARE OF o`)[0];
    if (!row) throw new PlatformFault('unauthenticated', 'An operator credential is required');
    return { id: row.id, roles: (await tx<{ role: OperatorRole }[]>`SELECT role FROM operator_roles WHERE operator_id = ${row.id} ORDER BY role`).map(item => item.role) };
  }
  private async view(tx: Tx, orgId: string): Promise<OperatorOrganization> {
    const org = (await tx<Row[]>`SELECT id, slug, state, revision::text, suspension_reason, deletion_scheduled_at, deletion_scheduled_at <= now() AS due FROM organizations WHERE id = ${orgId} AND human_managed`)[0];
    if (!org) throw new PlatformFault('not_found', 'Organization not found');
    const holds = await tx<Row[]>`SELECT id, reason, placed_at FROM legal_holds WHERE org_id = ${orgId} AND released_at IS NULL ORDER BY placed_at, id LIMIT 50`;
    const subscription = (await tx<Row[]>`SELECT state FROM billing_subscriptions WHERE org_id = ${orgId}`)[0]?.state ?? 'free';
    const pending = (await tx<Row[]>`SELECT * FROM operator_approvals WHERE org_id = ${orgId} AND state = 'pending' AND expires_at > now()`)[0];
    const blockers: string[] = [];
    if (org.state !== 'deletion_pending') blockers.push('not_scheduled'); else if (!org.due) blockers.push('recovery_window');
    if (holds.length) blockers.push('legal_hold'); if (BILLABLE.includes(subscription)) blockers.push('billable_subscription');
    const count = async (table: string) => Number((await tx.unsafe(`SELECT count(*)::text AS total FROM ${table} WHERE org_id = $1`, [orgId]))[0].total);
    // Counts only. An operator learns how much would be kept, never what it says.
    return parseComponent('OperatorOrganization', { id: org.id, slug: org.slug, state: org.state, revision: org.revision, suspensionReason: org.suspension_reason, deletionScheduledAt: org.deletion_scheduled_at?.toISOString() ?? null,
      subscriptionState: subscription, legalHolds: holds.map(row => ({ id: row.id, reason: row.reason, placedAt: row.placed_at.toISOString() })), pendingApproval: pending ? approvalView(pending) : null, deletionBlockers: blockers,
      retained: { events: await count('platform_events'), invoices: await count('billing_invoices'), operatorActions: await count('operator_actions') } });
  }
  /** An organization as an operator sees it: its state, what blocks its deletion, and how much would be kept. */
  async organization(tokenHash: string, orgId: string): Promise<OperatorOrganization> {
    return this.sql.begin(async tx => { await this.authenticate(tx, tokenHash); return this.view(tx, orgId); });
  }

  private async record(tx: Tx, operator: OperatorIdentity, role: OperatorRole, action: string, orgId: string, reason: string, requestId: string, approvalId: string | null = null) {
    await tx`INSERT INTO operator_actions (id, operator_id, role, action, org_id, reason, approval_id, request_id) VALUES (${randomUUID()}, ${operator.id}, ${role}, ${action}, ${orgId}, ${reason}, ${approvalId}, ${requestId})`;
    // The organization's own log says that Cloud acted and what it did. Who the operator was stays in Cloud's record.
    const revision = (await tx<{ revision: string }[]>`UPDATE organizations SET revision = revision + 1 WHERE id = ${orgId} RETURNING revision::text`)[0]!.revision;
    await tx`INSERT INTO platform_events (id, source, org_id, actor_kind, action, resource_kind, resource_id, revision, request_id) VALUES (${randomUUID()}, 'operator', ${orgId}, 'system', ${`operator.${action}`}, 'organization', ${orgId}, ${revision}, ${requestId})`;
  }

  async execute(tokenHash: string, orgId: string, command: OperatorCommand, requestId: string): Promise<OperatorReceipt> {
    return this.sql.begin(async tx => {
      const operator = await this.authenticate(tx, tokenHash);
      const role = REQUIRED[command.kind].find(item => operator.roles.includes(item));
      if (!role) throw new PlatformFault('forbidden', 'This operator role cannot do that');
      const org = (await tx<Row[]>`SELECT id, state, revision::text, deletion_scheduled_at FROM organizations WHERE id = ${orgId} AND human_managed FOR UPDATE`)[0];
      if (!org) throw new PlatformFault('not_found', 'Organization not found');
      // Decided against the state the operator was looking at. If it moved, they look again.
      if ('expectedRevision' in command && command.expectedRevision !== org.revision) throw new PlatformFault('conflict', 'The organization changed; review it again before acting');
      const held = async () => (await tx`SELECT 1 FROM legal_holds WHERE org_id = ${orgId} AND released_at IS NULL`).length > 0;
      let message: string;
      switch (command.kind) {
        case 'suspend':
          if (org.state !== 'active') throw new PlatformFault('conflict', 'Only an active organization can be suspended');
          await tx`UPDATE organizations SET state = 'suspended', suspension_reason = ${command.reasonCode} WHERE id = ${orgId}`;
          await this.record(tx, operator, role, 'organization.suspended', orgId, command.reason, requestId); message = 'Organization suspended'; break;
        case 'reinstate':
          if (org.state !== 'suspended') throw new PlatformFault('conflict', 'This organization is not suspended');
          await tx`UPDATE organizations SET state = 'active', suspension_reason = NULL WHERE id = ${orgId}`;
          await this.record(tx, operator, role, 'organization.reinstated', orgId, command.reason, requestId); message = 'Organization reinstated'; break;
        case 'hold-place':
          if (org.state === 'deleted') throw new PlatformFault('conflict', 'This organization is already deleted');
          await tx`INSERT INTO legal_holds (id, org_id, reason, placed_by) VALUES (${randomUUID()}, ${orgId}, ${command.reason}, ${operator.id})`;
          await this.record(tx, operator, role, 'legal_hold.placed', orgId, command.reason, requestId); message = 'Legal hold placed'; break;
        case 'hold-release': {
          const released = await tx`UPDATE legal_holds SET released_by = ${operator.id}, released_at = now() WHERE id = ${command.holdId} AND org_id = ${orgId} AND released_at IS NULL RETURNING 1`;
          if (!released.length) throw new PlatformFault('not_found', 'Legal hold not found');
          await this.record(tx, operator, role, 'legal_hold.released', orgId, command.reason, requestId); message = 'Legal hold released'; break;
        }
        case 'delete-now-request': {
          // Only what its owner already asked to delete can be deleted early. An operator cannot start a deletion.
          if (org.state !== 'deletion_pending') throw new PlatformFault('conflict', 'Only an organization whose deletion is already scheduled can be deleted early');
          if (await held()) throw new PlatformFault('conflict', 'This organization is under a legal hold');
          if ((await tx`SELECT 1 FROM operator_approvals WHERE org_id = ${orgId} AND state = 'pending' AND expires_at > now()`).length) throw new PlatformFault('conflict', 'A request for this organization is already waiting');
          // A request nobody decided in time no longer stands in the way of a new one.
          await tx`DELETE FROM operator_approvals WHERE org_id = ${orgId} AND state = 'pending' AND expires_at <= now()`;
          const approvalId = randomUUID();
          // The revision recorded is the one after this request is logged: any later change voids the request.
          await this.record(tx, operator, role, 'organization.delete_now.requested', orgId, command.reason, requestId);
          const revision = (await tx<{ revision: string }[]>`SELECT revision::text FROM organizations WHERE id = ${orgId}`)[0]!.revision;
          await tx`INSERT INTO operator_approvals (id, action, org_id, target_revision, requested_by, reason, expires_at) VALUES (${approvalId}, 'organization.delete_now', ${orgId}, ${revision}, ${operator.id}, ${command.reason}, now() + make_interval(hours => ${APPROVAL_HOURS}))`;
          message = 'Early deletion requested; a second operator must approve it'; break;
        }
        case 'delete-now-approve': case 'delete-now-reject': {
          const approval = (await tx<Row[]>`SELECT * FROM operator_approvals WHERE id = ${command.approvalId} AND org_id = ${orgId} FOR UPDATE`)[0];
          if (!approval || approval.state !== 'pending') throw new PlatformFault('not_found', 'No pending request with that identifier');
          if (approval.expires_at <= new Date()) throw new PlatformFault('conflict', 'This request has expired');
          if (approval.requested_by === operator.id) throw new PlatformFault('forbidden', 'A request must be decided by a different operator than the one who made it');
          if (command.kind === 'delete-now-reject') {
            await tx`UPDATE operator_approvals SET state = 'rejected', decided_by = ${operator.id}, decided_at = now() WHERE id = ${approval.id}`;
            await this.record(tx, operator, role, 'organization.delete_now.rejected', orgId, command.reason, requestId, approval.id); message = 'Early deletion rejected'; break;
          }
          // Every gate is checked again now, at the moment it becomes irreversible.
          if (org.state !== 'deletion_pending') throw new PlatformFault('conflict', 'This organization is no longer scheduled for deletion');
          if (String(approval.target_revision) !== org.revision) throw new PlatformFault('conflict', 'The organization changed since the request was made; it must be requested again');
          if (await held()) throw new PlatformFault('conflict', 'This organization is under a legal hold');
          if ((await tx`SELECT 1 FROM billing_subscriptions WHERE org_id = ${orgId} AND state = ANY(${`{${BILLABLE.join(',')}}`}::text[])`).length) throw new PlatformFault('conflict', 'This organization still has a subscription the provider may charge');
          await tx`UPDATE operator_approvals SET state = 'executed', decided_by = ${operator.id}, decided_at = now() WHERE id = ${approval.id}`;
          await tx`UPDATE organizations SET state = 'deleted', deletion_scheduled_at = NULL WHERE id = ${orgId}`;
          await this.record(tx, operator, role, 'organization.deleted', orgId, command.reason, requestId, approval.id); message = 'Organization deleted'; break;
        }
      }
      return parseComponent('OperatorReceipt', { organization: await this.view(tx, orgId), message });
    });
  }

  /** The record of what operators did to one organization, oldest first. */
  async actions(tokenHash: string, orgId: string): Promise<readonly { readonly operatorId: string; readonly role: OperatorRole; readonly action: string; readonly reason: string; readonly approvalId: string | null; readonly createdAt: string }[]> {
    return this.sql.begin(async tx => {
      await this.authenticate(tx, tokenHash);
      return (await tx<Row[]>`SELECT * FROM operator_actions WHERE org_id = ${orgId} ORDER BY sequence`).map(row => ({ operatorId: row.operator_id, role: row.role, action: row.action, reason: row.reason, approvalId: row.approval_id, createdAt: row.created_at.toISOString() }));
    });
  }
}
