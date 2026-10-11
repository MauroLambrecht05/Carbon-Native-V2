import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import { PlatformFault, parseComponent, type EnvironmentScope, type Permission, type Role } from '@carbon/contracts/platform';
import type { AccountRegistryAuthority } from '../application/usecases/RegistryPublishing.ts';

/** Resolves an account's current access to one environment and that environment's Registry binding, in one transaction. */
export class PostgresAccountRegistryAuthority extends PostgresPlatformAuthority implements AccountRegistryAuthority {
  async authorize(actor: OrganizationActor, scope: EnvironmentScope, permission: Permission, mutation: boolean) {
    parseComponent('EnvironmentScope', scope);
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`;
      await this.lockAccounts(tx, [actor.accountId], true);
      const current = await this.actor(tx, actor);
      if (mutation && !current.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
      const access = await this.resolveInTransaction(tx, actor, scope);
      if (!access.permissions.includes(permission)) throw new PlatformFault('forbidden', 'This registry operation is not permitted');
      const org = await this.organization(tx, scope.orgId, actor.accountId);
      const bindings = await tx`SELECT id FROM service_bindings WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
        AND owner = 'registry' AND state IN ('ready', 'paused') AND remote_resource_id IS NOT NULL`;
      if (!bindings.length) throw new PlatformFault('capability', 'This environment has no ready Registry binding');
      return { bindingId: bindings[0].id as string, role: org.role as Role,
        principal: parseComponent('Principal', { id: actor.accountId, kind: 'account', audience: 'dashboard', credentialId: actor.sessionId, permissionRevision: actor.permissionRevision }) };
    });
  }
}
