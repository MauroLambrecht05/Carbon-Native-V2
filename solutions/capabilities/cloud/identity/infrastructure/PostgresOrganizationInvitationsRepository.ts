import { randomUUID } from "node:crypto";
import { parseComponent, PlatformFault } from "@carbon/contracts/platform";
import type { OrganizationActor } from "../application/ports/OrganizationRepository.ts";
import type { InvitationAcceptance, InvitationMutation, OrganizationInvitationsRepository } from "../application/ports/OrganizationInvitationsRepository.ts";
import { authorizeInvitationRole } from "../domain/policies/OrganizationPolicy.ts";
import { PostgresOrganizationAuthority } from "./PostgresOrganizationAuthority.ts";

export class PostgresOrganizationInvitationsRepository extends PostgresOrganizationAuthority implements OrganizationInvitationsRepository {
  private async manager(tx: Bun.TransactionSQL, actor: OrganizationActor, orgId: string, write = false) {
    if (write) await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
    else await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR SHARE`;
    await this.lockAccounts(tx, [actor.accountId], !write);
    const current = await this.actor(tx, actor); const org = await this.organization(tx, orgId, actor.accountId);
    this.mfaGuard(org, current); authorizeInvitationRole(org.role);
    if (write && org.state !== "active") throw new PlatformFault("forbidden", "This organization is not active");
    return { current, org };
  }
  async list(actor: OrganizationActor, orgId: string, revision: string, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      const { org } = await this.manager(tx, actor, orgId);
      if (org.org_revision !== revision) throw new PlatformFault("conflict", "Organization changed; restart the list");
      const rows = await tx`SELECT *, revision::text AS invite_revision, CASE WHEN state = 'pending' AND expires_at <= now() THEN 'expired' ELSE state END AS visible_state
        FROM invitations WHERE org_id = ${orgId} AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${limit}`;
      return rows.map((r: Record<string, any>) => parseComponent("InvitationSummary", { id: r.id, email: r.email, role: r.role, state: r.visible_state,
        revision: r.invite_revision, invitedBy: r.invited_by, expiresAt: r.expires_at.toISOString() }));
    });
  }
  async destination(actor: OrganizationActor, orgId: string, invitationId: string) {
    return this.sql.begin(async tx => {
      const { org } = await this.manager(tx, actor, orgId);
      const rows = await tx`SELECT email, role FROM invitations WHERE id = ${invitationId} AND org_id = ${orgId}`;
      if (!rows.length) throw new PlatformFault("not_found", "Invitation not found");
      authorizeInvitationRole(org.role, rows[0].role); return rows[0].email as string;
    });
  }
  private async discardMail(tx: Bun.TransactionSQL, invitationId: string) {
    await tx`UPDATE account_email_outbox SET state = 'expired', protected_message = NULL, lease_id = NULL, lease_expires_at = NULL
      WHERE invitation_id = ${invitationId} AND state IN ('pending', 'sending')`;
  }
  private async receipt(tx: Bun.TransactionSQL, orgId: string, actorId: string, invitationId: string, action: string, requestId: string,
    scopeKey: string, keyDigest: string, requestDigest: string) {
    const rows = await tx`UPDATE organizations SET revision = revision + 1 WHERE id = ${orgId} RETURNING revision::text`;
    await tx`INSERT INTO organization_security_events (id, org_id, actor_account_id, invitation_id, action, request_id, revision)
      VALUES (${randomUUID()}, ${orgId}, ${actorId}, ${invitationId}, ${action}, ${requestId}, ${rows[0].revision})`;
    const result = parseComponent("InvitationReceipt", { id: invitationId, orgId, revision: rows[0].revision, message: action === 'invitation.accept' ? "Invitation accepted" : "Invitation updated" });
    await tx`INSERT INTO organization_commands (account_id, scope_key, key_digest, request_digest, organization_id, result)
      VALUES (${actorId}, ${scopeKey}, ${keyDigest}, ${requestDigest}, ${orgId}, ${JSON.stringify(result)}::text::jsonb)`;
    return result;
  }
  async execute(input: InvitationMutation) {
    return this.sql.begin(async tx => {
      const { current, org } = await this.manager(tx, input.actor, input.orgId, true);
      const scopeKey = `invitations:${input.orgId}`; const command = input.command;
      const rows = command.kind === "create" ? [] : await tx`SELECT * FROM invitations WHERE id = ${command.invitationId} AND org_id = ${input.orgId}`;
      const existing = rows[0];
      if (command.kind !== "create" && !existing) throw new PlatformFault("not_found", "Invitation not found");
      authorizeInvitationRole(org.role, command.kind === "create" ? command.role : existing.role);
      if (command.kind !== 'cancel' && org.project_access === 'assigned' && (command.kind === 'create' ? command.role : existing.role) === 'Admin') {
        throw new PlatformFault('forbidden', 'You cannot delegate access to all projects');
      }
      const previous = await tx`SELECT request_digest, result FROM organization_commands WHERE account_id = ${current.id} AND scope_key = ${scopeKey} AND key_digest = ${input.keyDigest}`;
      if (previous.length) {
        if (previous[0].request_digest !== input.requestDigest) throw new PlatformFault("conflict", "The idempotency key was used for another command");
        return parseComponent("InvitationReceipt", previous[0].result);
      }
      if (!current.fresh) throw new PlatformFault("forbidden", "Recent authentication is required", { authentication: "fresh_required" });
      if (org.org_revision !== input.expectedRevision) throw new PlatformFault("conflict", "Organization changed; refresh before retrying");
      if (existing && existing.state !== "pending") throw new PlatformFault("conflict", "This invitation is no longer pending");
      const id = existing?.id ?? randomUUID();
      if (command.kind === "cancel") {
        await tx`UPDATE invitations SET state = 'cancelled', revision = revision + 1 WHERE id = ${id}`;
        await this.discardMail(tx, id);
      } else {
        const delivery = input.delivery; if (!delivery) throw new Error("Missing invitation delivery");
        const email = command.kind === "create" ? command.email : existing.email;
        const members = await tx`SELECT m.id FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.org_id = ${input.orgId} AND m.state = 'active' AND a.primary_email = ${email}`;
        if (members.length) throw new PlatformFault("conflict", "This address already belongs to an active member");
        for (const key of [...new Set(delivery.rateKeys)].sort()) {
          const limits = await tx`INSERT INTO account_auth_rate_limits (key_hash, window_start, requests) VALUES (${key}, now(), 1)
            ON CONFLICT (key_hash) DO UPDATE SET requests = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '1 hour' THEN 1 ELSE account_auth_rate_limits.requests + 1 END,
              window_start = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '1 hour' THEN now() ELSE account_auth_rate_limits.window_start END RETURNING requests`;
          if (limits[0].requests > 20) throw new PlatformFault("rate_limited", "Too many invitations; try again later");
        }
        if (command.kind === "create") {
          const superseded = await tx`UPDATE invitations SET state = 'superseded', revision = revision + 1 WHERE org_id = ${input.orgId} AND email = ${email} AND state = 'pending' RETURNING id`;
          for (const row of superseded) await this.discardMail(tx, row.id);
          await tx`INSERT INTO invitations (id, org_id, email, role, token_hash, state, invited_by, inviter_membership_id, inviter_membership_revision, expires_at)
            VALUES (${id}, ${input.orgId}, ${email}, ${command.role}, ${delivery.tokenHash}, 'pending', ${current.id}, ${org.membership_id}, ${org.membership_revision}, ${delivery.expiresAt})`;
        } else {
          // No assignment/grant delivery is silently reduced to an organization role.
          if (!Array.isArray(existing.assignments) || existing.assignments.length) throw new PlatformFault("capability", "Scoped invitation assignments are not configured");
          await this.discardMail(tx, id);
          await tx`UPDATE invitations SET token_hash = ${delivery.tokenHash}, invited_by = ${current.id}, inviter_membership_id = ${org.membership_id},
            inviter_membership_revision = ${org.membership_revision}, expires_at = ${delivery.expiresAt}, revision = revision + 1 WHERE id = ${id}`;
        }
        await tx`INSERT INTO account_email_outbox (id, invitation_id, protected_message, expires_at) VALUES (${delivery.id}, ${id}, ${delivery.protectedMessage}, ${delivery.expiresAt})`;
      }
      return this.receipt(tx, input.orgId, current.id, id, `invitation.${command.kind}`, input.requestId, scopeKey, input.keyDigest, input.requestDigest);
    });
  }
  private async recipient(tx: Bun.TransactionSQL, actor: OrganizationActor, tokenHash: string, write: boolean) {
    const discovered = await tx`SELECT org_id, invited_by FROM invitations WHERE token_hash = ${tokenHash}`;
    if (!discovered.length) throw new PlatformFault("not_found", "Invitation not found");
    const orgId = discovered[0].org_id;
    if (write) await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
    else await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR SHARE`;
    // Re-read after the org lock: resend may have replaced both proof and inviter.
    const rows = await tx`SELECT i.*, o.name AS organization_name, o.owner_policy, o.state AS organization_state, o.human_managed
      FROM invitations i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = ${tokenHash} AND i.org_id = ${orgId}`;
    const invite = rows[0]; if (!invite) throw new PlatformFault("not_found", "Invitation not found");
    await this.lockAccounts(tx, [actor.accountId, invite.invited_by], !write);
    // Accepting a new membership does not require authority over old memberships.
    const current = await this.actor(tx, actor, false);
    const accounts = await tx`SELECT primary_email FROM accounts WHERE id = ${actor.accountId} AND verified_at IS NOT NULL`;
    if (accounts[0]?.primary_email !== invite.email || !invite.human_managed || invite.organization_state !== 'active') throw new PlatformFault("not_found", "Invitation not found");
    return { invite, current };
  }
  private async usable(tx: Bun.TransactionSQL, invite: Record<string, any>) {
    if (invite.state !== 'pending' || invite.expires_at.getTime() <= Date.now()) throw new PlatformFault("not_found", "Invitation not found");
    if (!Array.isArray(invite.assignments) || invite.assignments.length) throw new PlatformFault("capability", "Scoped invitation assignments are not configured");
    const inviters = await tx`SELECT m.role, m.project_access, EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active') AS mfa_enrolled
      FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.org_id = ${invite.org_id} AND a.id = ${invite.invited_by} AND a.state = 'active' AND m.state = 'active'
        AND m.id = ${invite.inviter_membership_id} AND m.revision = ${invite.inviter_membership_revision}`;
    if (!inviters.length || (invite.owner_policy.requireMfa && !inviters[0].mfa_enrolled)) throw new PlatformFault("not_found", "Invitation not found");
    authorizeInvitationRole(inviters[0].role, invite.role);
    if (invite.role === 'Admin' && inviters[0].project_access === 'assigned') throw new PlatformFault('not_found', 'Invitation not found');
  }
  async preview(actor: OrganizationActor, tokenHash: string) {
    return this.sql.begin(async tx => {
      const { invite } = await this.recipient(tx, actor, tokenHash, false); await this.usable(tx, invite);
      return parseComponent("InvitationPreview", { id: invite.id, orgId: invite.org_id, organizationName: invite.organization_name,
        role: invite.role, requireMfa: invite.owner_policy.requireMfa === true, expiresAt: invite.expires_at.toISOString() });
    });
  }
  async accept(input: InvitationAcceptance) {
    return this.sql.begin(async tx => {
      const { invite, current } = await this.recipient(tx, input.actor, input.tokenHash, true); const scopeKey = "invitation-accept";
      const previous = await tx`SELECT request_digest, result FROM organization_commands WHERE account_id = ${current.id} AND scope_key = ${scopeKey} AND key_digest = ${input.keyDigest}`;
      if (previous.length) {
        if (previous[0].request_digest !== input.requestDigest) throw new PlatformFault("conflict", "The idempotency key was used for another command");
        if (invite.accepted_by !== current.id) throw new PlatformFault("not_found", "Invitation not found");
        const org = await this.organization(tx, invite.org_id, current.id); this.mfaGuard(org, current);
        return parseComponent("InvitationReceipt", previous[0].result);
      }
      await this.usable(tx, invite); this.mfaGuard({ owner_policy: invite.owner_policy }, current);
      if (!current.fresh) throw new PlatformFault("forbidden", "Recent authentication is required", { authentication: "fresh_required" });
      const memberships = await tx`SELECT id, state FROM memberships WHERE account_id = ${current.id} AND org_id = ${invite.org_id}`;
      if (memberships[0]?.state === 'active') throw new PlatformFault("conflict", "You already belong to this organization");
      if (memberships[0]) {
        await tx`DELETE FROM membership_grants WHERE membership_id = ${memberships[0].id}`;
        await tx`DELETE FROM project_assignments WHERE membership_id = ${memberships[0].id}`;
      }
      await tx`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${randomUUID()}, ${current.id}, ${invite.org_id}, ${invite.role}, 'active')
        ON CONFLICT (account_id, org_id) DO UPDATE SET state = 'active', role = EXCLUDED.role, project_access = 'role', revision = memberships.revision + 1`;
      await tx`UPDATE invitations SET state = 'accepted', accepted_by = ${current.id}, accepted_at = now(), revision = revision + 1 WHERE id = ${invite.id}`;
      await this.discardMail(tx, invite.id);
      await tx`UPDATE accounts SET permission_revision = permission_revision + 1, revision = revision + 1, updated_at = now() WHERE id = ${current.id}`;
      return this.receipt(tx, invite.org_id, current.id, invite.id, "invitation.accept", input.requestId, scopeKey, input.keyDigest, input.requestDigest);
    });
  }
}
