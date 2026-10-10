import { PostgresOrganizationAuthority } from "./PostgresOrganizationAuthority.ts";
import { randomUUID } from "node:crypto";
import { PlatformFault, parseComponent, type Role, type OrganizationCommand } from "@carbon/contracts/platform";
import type { OrganizationActor, OrganizationMutation, OrganizationRepository } from "../application/ports/OrganizationRepository.ts";
import { authorizeOrganizationCommand } from "../domain/policies/OrganizationPolicy.ts";
import { ROLE_PERMISSIONS } from "../domain/policies/PlatformAuthorization.ts";
import { PostgresPlatformAuthority } from "./PostgresPlatformAuthority.ts";

function summary(row: Record<string, any>) {
  return parseComponent("OrganizationSummary", { id: row.id, name: row.name, slug: row.slug, state: row.state, revision: row.org_revision,
    role: row.role, membershipId: row.membership_id, membershipRevision: row.membership_revision, requireMfa: row.owner_policy.requireMfa === true });
}
export class PostgresOrganizationRepository extends PostgresOrganizationAuthority implements OrganizationRepository {

  async list(actor: OrganizationActor, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.lockAccounts(tx, [actor.accountId], true); await this.actor(tx, actor);
      const rows = await tx`SELECT o.*, o.revision::text AS org_revision, m.id AS membership_id, m.role, m.revision::text AS membership_revision
        FROM organizations o JOIN memberships m ON m.org_id = o.id WHERE m.account_id = ${actor.accountId} AND m.state = 'active'
          AND o.human_managed AND o.state <> 'deleted' AND (${afterId ?? null}::uuid IS NULL OR o.id > ${afterId ?? null}::uuid)
        ORDER BY o.id LIMIT ${limit}`;
      return rows.map(summary);
    });
  }
  async get(actor: OrganizationActor, orgId: string) {
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR SHARE`;
      await this.lockAccounts(tx, [actor.accountId], true); const current = await this.actor(tx, actor);
      const org = await this.organization(tx, orgId, actor.accountId);
      const transfers = await tx`SELECT * FROM organization_ownership_transfers WHERE org_id = ${orgId} AND state = 'pending' AND expires_at > now()
        AND (from_account_id = ${actor.accountId} OR to_account_id = ${actor.accountId})`;
      const transfer = transfers[0];
      const canSeeTransfer = !org.owner_policy.requireMfa || (current.mfa_enrolled && current.mfa_verified_at);
      return { organization: summary(org), transfer: transfer && canSeeTransfer ? parseComponent("OwnershipTransfer", { id: transfer.id,
        fromAccountId: transfer.from_account_id, toAccountId: transfer.to_account_id, previousRole: transfer.previous_role, expiresAt: transfer.expires_at.toISOString() }) : null };
    });
  }
  async members(actor: OrganizationActor, orgId: string, revision: string, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR SHARE`;
      await this.lockAccounts(tx, [actor.accountId], true); const current = await this.actor(tx, actor);
      const org = await this.organization(tx, orgId, actor.accountId); this.mfaGuard(org, current);
      if (!ROLE_PERMISSIONS[org.role as Role].includes("members.manage")) throw new PlatformFault("forbidden", "Membership management is not allowed");
      if (org.org_revision !== revision) throw new PlatformFault("conflict", "Organization changed; restart the list");
      const rows = await tx<{ id: string; account_id: string; name: string; primary_email: string; role: Role; revision: string }[]>`
        SELECT m.id, m.account_id, a.name, a.primary_email, m.role, m.revision::text FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.org_id = ${orgId} AND m.state = 'active' AND (${afterId ?? null}::uuid IS NULL OR m.id > ${afterId ?? null}::uuid) ORDER BY m.id LIMIT ${limit}`;
      return rows.map(row => parseComponent("OrganizationMember", { id: row.id, accountId: row.account_id, name: row.name, email: row.primary_email, role: row.role, revision: row.revision }));
    });
  }

  async execute(mutation: OrganizationMutation) {
    try { return await this.sql.begin(async tx => {
      const command = mutation.command; const scopeKey = mutation.orgId ?? "create";
      if (command.kind !== "create") {
        if (!mutation.orgId) throw new PlatformFault("validation", "An organization is required");
        await tx`SELECT id FROM organizations WHERE id = ${mutation.orgId} FOR UPDATE`;
      }
      const targets = "membershipId" in command ? await tx`SELECT account_id, role, id, project_access FROM memberships
        WHERE id = ${command.membershipId} AND org_id = ${mutation.orgId!} AND state = 'active'` : [];
      const transfers = command.kind === "ownership-accept" ? await tx`SELECT * FROM organization_ownership_transfers
        WHERE id = ${command.transferId} AND org_id = ${mutation.orgId!} AND state = 'pending' AND expires_at > now()` : [];
      const target = targets[0]; const transfer = transfers[0];
      const policyMembers = command.kind === "policy" ? await tx`SELECT account_id FROM memberships WHERE org_id = ${mutation.orgId!} AND state = 'active'` : [];
      await this.lockAccounts(tx, [mutation.actor.accountId, ...(target ? [target.account_id] : []),
        ...(transfer ? [transfer.from_account_id, transfer.to_account_id] : []), ...policyMembers.map((row: { account_id: string }) => row.account_id)]);
      // Creating a new organization needs live account authentication, not
      // authority over an existing organization. A concurrent creation changes
      // permission revision and must not defeat an otherwise identical retry.
      const actor = await this.actor(tx, mutation.actor, command.kind !== "create");
      let org = command.kind !== "create" ? await this.organization(tx, mutation.orgId!, actor.id) : undefined;
      if (org) {
        if (org.state !== "active") throw new PlatformFault("forbidden", "This organization is not active");
        if (command.kind !== "leave") this.mfaGuard(org, actor);
        authorizeOrganizationCommand(org.role as Role, command as Exclude<typeof command, { kind: "create" }>, target?.role);
      }
      const previous = await tx`SELECT request_digest, result, organization_id FROM organization_commands
        WHERE account_id = ${actor.id} AND scope_key = ${scopeKey} AND key_digest = ${mutation.keyDigest}`;
      if (previous.length) {
        if (previous[0].request_digest !== mutation.requestDigest) throw new PlatformFault("conflict", "The idempotency key was used for another command");
        if (!org) await this.organization(tx, previous[0].organization_id, actor.id);
        return parseComponent("OrganizationReceipt", previous[0].result);
      }
      if (!actor.fresh) throw new PlatformFault("forbidden", "Recent authentication is required", { authentication: "fresh_required" });
      if (org && org.org_revision !== mutation.expectedRevision) throw new PlatformFault("conflict", "Organization changed; refresh before retrying");
      if (org && org.project_access === 'assigned' && target && (
        (command.kind === 'member-role' && (target.project_access === 'all' || (target.project_access === 'role' && command.role === 'Admin')))
        || (command.kind === 'ownership-propose' && target.project_access !== 'assigned'))) {
        throw new PlatformFault('forbidden', 'You cannot delegate access to all projects');
      }
      if (org?.project_access === 'assigned' && target && ['member-role', 'ownership-propose'].includes(command.kind)) {
        const outside = await tx`SELECT 1 FROM project_assignments t WHERE t.membership_id = ${target.id}
          AND NOT EXISTS (SELECT 1 FROM project_assignments a WHERE a.membership_id = ${org.membership_id} AND a.project_id = t.project_id) LIMIT 1`;
        if (outside.length) throw new PlatformFault('forbidden', 'The member has projects outside your authority');
      }
      let orgId = mutation.orgId; let transferId: string | undefined;
      const affected = new Set<string>();
      if (command.kind === "create") {
        orgId = randomUUID();
        await tx`INSERT INTO organizations (id, name, slug, human_managed) VALUES (${orgId}, ${command.name}, ${command.slug}, true)`;
        await tx`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${randomUUID()}, ${actor.id}, ${orgId}, 'Owner', 'active')`;
        affected.add(actor.id);
      } else if (command.kind === "update") await tx`UPDATE organizations SET name = ${command.name}, slug = ${command.slug} WHERE id = ${orgId!}`;
      else if (command.kind === "policy") {
        if (command.requireMfa && (!actor.mfa_enrolled || !actor.mfa_verified_at)) throw new PlatformFault("forbidden", "Enroll and verify MFA before requiring it");
        await tx`UPDATE organizations SET owner_policy = jsonb_set(owner_policy, '{requireMfa}', ${JSON.stringify(command.requireMfa)}::text::jsonb) WHERE id = ${orgId!}`;
        for (const row of policyMembers) affected.add(row.account_id);
      } else if (command.kind === "member-access") {
        if (!target) throw new PlatformFault("not_found", "Member not found");
        if (target.account_id === actor.id) throw new PlatformFault("validation", "Another administrator must change your own access");
        await this.replaceAccess(tx, mutation.actor, org!, target, command);
        affected.add(target.account_id);
      } else if (command.kind === "member-role" || command.kind === "member-revoke") {
        if (!target) throw new PlatformFault("not_found", "Member not found");
        if (target.account_id === actor.id) throw new PlatformFault("validation", "Use leave or ownership transfer to change your own membership");
        if (command.kind === "member-role") await tx`UPDATE memberships SET role = ${command.role}, revision = revision + 1 WHERE id = ${target.id}`;
        else await tx`UPDATE memberships SET state = 'revoked', revision = revision + 1 WHERE id = ${target.id}`;
        if (command.kind === "member-role") await tx`DELETE FROM membership_grants WHERE membership_id = ${target.id} AND NOT (${JSON.stringify(ROLE_PERMISSIONS[command.role])}::text::jsonb ? permission)`;
        else {
          await tx`DELETE FROM membership_grants WHERE membership_id = ${target.id}`;
          await tx`DELETE FROM project_assignments WHERE membership_id = ${target.id}`;
          await tx`UPDATE memberships SET project_access = 'role' WHERE id = ${target.id}`;
        }
        affected.add(target.account_id);
      } else if (command.kind === "leave") {
        const owners = await tx`SELECT id FROM memberships WHERE org_id = ${orgId!} AND state = 'active' AND role = 'Owner'`;
        if (org!.role === "Owner" && owners.length <= 1) throw new PlatformFault("conflict", "Transfer ownership before leaving the organization");
        await tx`UPDATE memberships SET state = 'revoked', revision = revision + 1 WHERE id = ${org!.membership_id}`;
        await tx`DELETE FROM membership_grants WHERE membership_id = ${org!.membership_id}`;
        await tx`DELETE FROM project_assignments WHERE membership_id = ${org!.membership_id}`;
        await tx`UPDATE memberships SET project_access = 'role' WHERE id = ${org!.membership_id}`;
        affected.add(actor.id);
      } else if (command.kind === "ownership-propose") {
        if (!target) throw new PlatformFault("not_found", "Member not found");
        if (target.account_id === actor.id || target.role === "Owner") throw new PlatformFault("validation", "Choose another non-owner member");
        await tx`UPDATE organization_ownership_transfers SET state = 'superseded' WHERE org_id = ${orgId!} AND state = 'pending'`;
        transferId = randomUUID();
        await tx`INSERT INTO organization_ownership_transfers (id, org_id, from_account_id, to_account_id, previous_role, state, expires_at)
          VALUES (${transferId}, ${orgId!}, ${actor.id}, ${target.account_id}, ${command.previousRole}, 'pending', now() + interval '24 hours')`;
      } else if (command.kind === "ownership-cancel") await tx`UPDATE organization_ownership_transfers SET state = 'cancelled' WHERE org_id = ${orgId!} AND state = 'pending'`;
      else if (command.kind === "ownership-accept") {
        if (!transfer || transfer.to_account_id !== actor.id) throw new PlatformFault("not_found", "Ownership proposal not found");
        const owners = await tx`SELECT id FROM memberships WHERE org_id = ${orgId!} AND account_id = ${transfer.from_account_id} AND role = 'Owner' AND state = 'active'`;
        if (!owners.length) throw new PlatformFault("conflict", "The proposing owner is no longer authorized");
        await tx`UPDATE memberships SET role = 'Owner', revision = revision + 1 WHERE id = ${org!.membership_id}`;
        await tx`UPDATE memberships SET role = ${transfer.previous_role}, revision = revision + 1 WHERE id = ${owners[0].id}`;
        await tx`DELETE FROM membership_grants WHERE membership_id = ${owners[0].id} AND NOT (${JSON.stringify(ROLE_PERMISSIONS[transfer.previous_role as Role])}::text::jsonb ? permission)`;
        await tx`UPDATE organization_ownership_transfers SET state = 'accepted', accepted_at = now() WHERE id = ${transfer.id}`;
        affected.add(actor.id); affected.add(transfer.from_account_id); transferId = transfer.id;
      }
      if (["leave", "member-role", "member-revoke", "member-access"].includes(command.kind)) await tx`UPDATE organization_ownership_transfers SET state = 'superseded' WHERE org_id = ${orgId!} AND state = 'pending'`;
      for (const id of [...affected].sort()) await tx`UPDATE accounts SET permission_revision = permission_revision + 1, revision = revision + 1, updated_at = now() WHERE id = ${id}`;
      const revisions = await tx`UPDATE organizations SET revision = revision + ${command.kind === "create" ? 0 : 1} WHERE id = ${orgId!} RETURNING revision::text`;
      await tx`INSERT INTO organization_security_events (id, org_id, actor_account_id, subject_account_id, action, request_id, revision)
        VALUES (${randomUUID()}, ${orgId!}, ${actor.id}, ${target?.account_id ?? null}, ${`organization.${command.kind}`}, ${mutation.requestId}, ${revisions[0].revision})`;
      const receipt = parseComponent("OrganizationReceipt", { id: orgId, revision: revisions[0].revision, message: "Organization updated", ...(transferId ? { transferId } : {}) });
      await tx`INSERT INTO organization_commands (account_id, scope_key, key_digest, request_digest, organization_id, result)
        VALUES (${actor.id}, ${scopeKey}, ${mutation.keyDigest}, ${mutation.requestDigest}, ${orgId!}, ${JSON.stringify(receipt)}::text::jsonb)`;
      return receipt;
    }); } catch (error) {
      if ((error as { constraint?: string })?.constraint === "organizations_slug_idx") throw new PlatformFault("conflict", "This organization namespace is already in use");
      throw error;
    }
  }

  async memberAccess(actor: OrganizationActor, orgId: string, membershipId: string) {
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${orgId} FOR SHARE`;
      await this.lockAccounts(tx, [actor.accountId], true); const current = await this.actor(tx, actor);
      const org = await this.organization(tx, orgId, actor.accountId); this.mfaGuard(org, current);
      if (!ROLE_PERMISSIONS[org.role as Role].includes('members.manage')) throw new PlatformFault('forbidden', 'Membership management is not allowed');
      const member = (await tx`SELECT role, project_access, revision::text FROM memberships WHERE id = ${membershipId} AND org_id = ${orgId} AND state = 'active'`)[0];
      if (!member) throw new PlatformFault('not_found', 'Member not found');
      const projects = await tx<{ project_id: string }[]>`SELECT project_id FROM project_assignments WHERE membership_id = ${membershipId} AND org_id = ${orgId} ORDER BY project_id LIMIT 101`;
      const grants = await tx<{ permission: string; project_id: string | null; environment_id: string | null; expires_at: Date | null }[]>`SELECT permission, project_id, environment_id, expires_at FROM membership_grants WHERE membership_id = ${membershipId} AND org_id = ${orgId} ORDER BY permission, project_id, environment_id LIMIT 33`;
      if (projects.length > 100 || grants.length > 32) throw new PlatformFault('capability', 'This membership exceeds the supported access configuration size');
      return parseComponent('MemberAccess', { membershipId, role: member.role, revision: member.revision, organizationRevision: org.org_revision,
        projectAccess: member.project_access, projectIds: projects.map(row => row.project_id), grants: grants.map(row => ({ permission: row.permission,
          scope: { orgId, ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.environment_id ? { environmentId: row.environment_id } : {}) },
          ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}) })) });
    });
  }

  private async replaceAccess(tx: Bun.TransactionSQL, actor: OrganizationActor, org: Record<string, any>, target: Record<string, any>, command: Extract<OrganizationCommand, { kind: 'member-access' }>) {
    const actorAll = org.project_access === 'all' || (org.project_access === 'role' && ['Owner', 'Admin'].includes(org.role));
    const targetAll = command.projectAccess === 'all' || (command.projectAccess === 'role' && ['Owner', 'Admin'].includes(target.role));
    if (targetAll && !actorAll) throw new PlatformFault('forbidden', 'You cannot delegate access to all projects');
    const projects = await tx`SELECT p.id FROM projects p WHERE p.org_id = ${org.id} AND p.state <> 'deleted'
      AND ${JSON.stringify(command.projectIds)}::text::jsonb ? p.id::text
      AND (${actorAll} OR EXISTS (SELECT 1 FROM project_assignments a WHERE a.membership_id = ${org.membership_id} AND a.project_id = p.id AND a.org_id = p.org_id))`;
    if (projects.length !== command.projectIds.length) throw new PlatformFault('not_found', 'An assigned project was not found');
    const authority = new PostgresPlatformAuthority(this.sql);
    const now = (await tx`SELECT now() AS at`)[0].at as Date;
    for (const grant of command.grants) {
      if (!ROLE_PERMISSIONS[target.role as Role].includes(grant.permission)) throw new PlatformFault('forbidden', 'This permission is unavailable to the member role');
      if (!grant.scope.projectId && !actorAll) throw new PlatformFault('forbidden', 'Organization-wide grants require access to all projects');
      if (grant.scope.projectId && !targetAll && !command.projectIds.includes(grant.scope.projectId)) throw new PlatformFault('validation', 'Assign the project before granting its permissions');
      const expiresAt = grant.expiresAt ? new Date(grant.expiresAt) : null;
      if (expiresAt && expiresAt <= now) throw new PlatformFault('validation', 'Grant expiry must be in the future');
      const access = await authority.resolveInTransaction(tx, actor, grant.scope, expiresAt);
      if (!access.permissions.includes(grant.permission)) throw new PlatformFault('forbidden', 'You cannot delegate this permission for the requested scope and duration');
    }
    await tx`DELETE FROM membership_grants WHERE membership_id = ${target.id}`;
    await tx`DELETE FROM project_assignments WHERE membership_id = ${target.id}`;
    await tx`UPDATE memberships SET project_access = ${command.projectAccess}, revision = revision + 1 WHERE id = ${target.id}`;
    for (const projectId of command.projectIds) await tx`INSERT INTO project_assignments (membership_id, org_id, project_id) VALUES (${target.id}, ${org.id}, ${projectId})`;
    for (const grant of command.grants) await tx`INSERT INTO membership_grants (id, membership_id, org_id, project_id, environment_id, permission, expires_at)
      VALUES (${randomUUID()}, ${target.id}, ${org.id}, ${grant.scope.projectId ?? null}, ${grant.scope.environmentId ?? null}, ${grant.permission}, ${grant.expiresAt ? new Date(grant.expiresAt) : null})`;
  }
}
