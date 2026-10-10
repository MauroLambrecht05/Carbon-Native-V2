import { PlatformFault, parseComponent, type EnvironmentScope } from '@carbon/contracts/platform';
import type { RegistryNamespaces } from '../application/ports/RegistryNamespaces.ts';

/** Reads Registry's own namespace record; the caller's identifiers only select it, they never create authority. */
export class PostgresRegistryNamespaces implements RegistryNamespaces {
  constructor(private readonly sql: Bun.SQL) {}
  async get(scope: EnvironmentScope, bindingId: string, stillAuthorized: () => Promise<boolean>) {
    return this.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '10s'`;
      const row = (await tx`SELECT n.id, n.state, e.revision::text AS revision FROM registry_environment_namespaces n
        JOIN platform_environments e ON e.id = n.id AND e.org_id = n.org_id AND e.project_id = n.project_id AND e.environment_id = n.environment_id
        WHERE e.org_id = ${scope.orgId} AND e.project_id = ${scope.projectId} AND e.environment_id = ${scope.environmentId} AND e.binding_id = ${bindingId} FOR SHARE OF e`)[0];
      if (!row) throw new PlatformFault('not_found', 'Registry namespace not found');
      if (!await stillAuthorized()) throw new PlatformFault('forbidden', 'Registry authority is no longer current');
      return parseComponent('RegistryNamespace', { id: row.id, state: row.state, revision: row.revision });
    });
  }
}
