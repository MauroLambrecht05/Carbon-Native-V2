import { PlatformFault, parseComponent, type Scope, type Role } from "@carbon/contracts/platform";
import type { OrganizationActor } from "../application/ports/OrganizationRepository.ts";
import type { PlatformAccessRepository } from "../application/ports/PlatformAccessRepository.ts";
import { accountGrants, type ResourceAuthority } from "../domain/policies/PlatformAuthorization.ts";
import { PostgresOrganizationAuthority } from "./PostgresOrganizationAuthority.ts";

export class PostgresPlatformAuthority extends PostgresOrganizationAuthority implements PlatformAccessRepository {
  async resolve(actor: OrganizationActor, scope: Scope) { return this.sql.begin(tx => this.resolveInTransaction(tx, actor, scope)); }

  /** Catalog mutations use this after acquiring their organization/account locks. */
  async resolveInTransaction(tx: Bun.TransactionSQL, actor: OrganizationActor, scope: Scope, grantValidThrough?: Date | null,
    catalogIntent?: 'project-restore' | 'environment-resume' | 'production-create' | 'project-recover' | 'environment-recover') {
    parseComponent("Scope", scope);
    if (scope.realmId) throw new PlatformFault("capability", "Realm authority is not configured");
    await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`;
    await this.lockAccounts(tx, [actor.accountId], true); const current = await this.actor(tx, actor);
    const org = await this.organization(tx, scope.orgId, actor.accountId); this.mfaGuard(org, current);
    const projectAccess = org.project_access === 'role' ? (["Owner", "Admin"].includes(org.role) ? 'all' : 'assigned') : org.project_access;
    const assignments = await tx<{ project_id: string }[]>`SELECT project_id FROM project_assignments WHERE membership_id = ${org.membership_id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId ?? null}::uuid`;
    const projectIds = assignments.map(row => row.project_id);
    let project: Record<string, any> | undefined; let environment: Record<string, any> | undefined;
    if (scope.projectId) {
      if (projectAccess === 'assigned' && !projectIds.includes(scope.projectId)) throw new PlatformFault("not_found", "Project not found");
      project = (await tx`SELECT *, revision::text AS project_revision FROM projects WHERE id = ${scope.projectId} AND org_id = ${scope.orgId} AND state <> 'deleted'`)[0];
      if (!project) throw new PlatformFault("not_found", "Project not found");
    }
    if (scope.environmentId) {
      environment = (await tx`SELECT *, revision::text AS environment_revision FROM environments WHERE id = ${scope.environmentId}
        AND project_id = ${scope.projectId!} AND org_id = ${scope.orgId} AND state <> 'deleted'`)[0];
      if (!environment) throw new PlatformFault("not_found", "Environment not found");
    }
    const rows = await tx<{ permission: string; project_id: string | null; environment_id: string | null }[]>`SELECT permission, project_id, environment_id FROM membership_grants
      WHERE membership_id = ${org.membership_id} AND org_id = ${scope.orgId} AND (expires_at IS NULL OR expires_at > now())
        AND (expires_at IS NULL OR (${grantValidThrough !== null} AND expires_at >= ${grantValidThrough ?? new Date()}))
        AND (project_id IS NULL OR project_id = ${scope.projectId ?? null}::uuid) AND (environment_id IS NULL OR environment_id = ${scope.environmentId ?? null}::uuid)`;
    const grants = rows.map(row => parseComponent("Grant", { permission: row.permission, scope: { orgId: scope.orgId,
      ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.environment_id ? { environmentId: row.environment_id } : {}) } }));
    const resource: ResourceAuthority = { organizationState: org.state,
      ...(project ? { projectState: ((catalogIntent === 'project-restore' && project.state === 'archived') || (catalogIntent === 'project-recover' && project.state === 'deletion_pending')) && !environment ? 'active' : project.state, productionMutationAllowed: project.production_mutations_allowed } : {}),
      ...(environment ? { environmentState: (catalogIntent === 'environment-resume' && environment.state === 'paused') || (catalogIntent === 'environment-recover' && environment.state === 'deletion_pending') ? 'active' : environment.state, environmentKind: environment.kind } : {}),
      ...(catalogIntent === 'production-create' && project && !environment ? { environmentKind: 'production' as const } : {}) };
    const effective = accountGrants({ id: actor.accountId, kind: 'account', audience: 'dashboard', credentialId: actor.sessionId, permissionRevision: actor.permissionRevision },
      { accountId: actor.accountId, orgId: scope.orgId, role: org.role as Role, state: 'active', permissionRevision: actor.permissionRevision, projectAccess,
        projectIds, grants }, scope, resource);
    // A credential narrows what its account may do; it never widens it. It applies only inside the scope it was issued
    // for, and only for the permissions it lists. Outside that scope the resource does not exist as far as it can tell.
    let permissions = effective.map(grant => grant.permission);
    if (current.delegated) {
      const inside = current.delegated_org_id === scope.orgId && (current.delegated_project_id === null || current.delegated_project_id === scope.projectId)
        && (current.delegated_environment_id === null || current.delegated_environment_id === scope.environmentId);
      if (!inside) throw new PlatformFault("not_found", scope.environmentId ? "Environment not found" : scope.projectId ? "Project not found" : "Organization not found");
      permissions = permissions.filter(permission => (current.delegated_permissions as string[]).includes(permission));
    }
    return parseComponent("AccessSnapshot", { scope, permissions, permissionRevision: actor.permissionRevision,
      membershipRevision: org.membership_revision, organizationRevision: org.org_revision,
      ...(project ? { projectRevision: project.project_revision } : {}), ...(environment ? { environmentRevision: environment.environment_revision } : {}) });
  }
}
