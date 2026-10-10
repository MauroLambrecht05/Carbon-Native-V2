import { PlatformFault } from "@carbon/contracts/platform";
import type { OrganizationActor } from "../application/ports/OrganizationRepository.ts";

export class PostgresOrganizationAuthority {
  constructor(protected readonly sql: Bun.SQL) {}

  protected async lockAccounts(tx: Bun.TransactionSQL, ids: readonly string[], shared = false) {
    for (const id of [...new Set(ids)].sort()) {
      if (shared) await tx`SELECT id FROM accounts WHERE id = ${id} FOR SHARE`;
      else await tx`SELECT id FROM accounts WHERE id = ${id} FOR UPDATE`;
    }
  }
  protected async actor(tx: Bun.TransactionSQL, input: OrganizationActor, checkPermissionRevision = true) {
    const rows = await tx`SELECT a.id, a.permission_revision::text, s.fresh_until > now() AS fresh, s.mfa_verified_at,
        EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active') AS mfa_enrolled
      FROM accounts a JOIN account_sessions s ON s.account_id = a.id
      WHERE a.id = ${input.accountId} AND a.state = 'active' AND s.id = ${input.sessionId}
        AND s.token_hash = ${input.tokenHash} AND s.csrf_hash = ${input.csrfHash} AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.security_revision = a.security_revision AND a.security_revision = ${input.securityRevision}
        AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))`;
    if (!rows.length) throw new PlatformFault("unauthenticated", "This session is no longer valid");
    if (checkPermissionRevision && rows[0].permission_revision !== input.permissionRevision) throw new PlatformFault("conflict", "Authorization changed; refresh before retrying");
    return rows[0];
  }
  protected async organization(tx: Bun.TransactionSQL, orgId: string, accountId: string) {
    const rows = await tx`SELECT o.*, o.revision::text AS org_revision, m.id AS membership_id, m.role, m.project_access, m.revision::text AS membership_revision
      FROM organizations o JOIN memberships m ON m.org_id = o.id
      WHERE o.id = ${orgId} AND o.human_managed AND o.state <> 'deleted' AND m.account_id = ${accountId} AND m.state = 'active'`;
    if (!rows.length) throw new PlatformFault("not_found", "Organization not found");
    return rows[0];
  }
  protected mfaGuard(organization: Record<string, any>, actor: Record<string, any>) {
    if (organization.owner_policy.requireMfa === true && (!actor.mfa_enrolled || !actor.mfa_verified_at)) throw new PlatformFault("forbidden", "This organization requires MFA", { authentication: "mfa_required" });
  }
}
