import type { EnvironmentScope } from '@carbon/contracts/platform';
import type { NativeEnvironmentDriver } from './NativeEnvironmentDriver.ts';

/** Registry reserves its own durable namespace; package publication will reference this identity. */
export class PostgresRegistryEnvironmentDriver implements NativeEnvironmentDriver {
  async initialize(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string) {
    await tx`INSERT INTO registry_environment_namespaces (id, org_id, project_id, environment_id, state)
      VALUES (${remoteId}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, 'active')`;
  }
  async setState(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string, state: 'active' | 'paused') {
    const rows = await tx`UPDATE registry_environment_namespaces SET state = ${state} WHERE id = ${remoteId} AND org_id = ${scope.orgId}
      AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} RETURNING id`;
    if (!rows.length) throw new Error('Registry namespace is missing');
  }
  /**
   * Removes the environment's namespace. Publishers and published packages belong to the organization, not to an
   * environment, and are public: they are not touched here.
   */
  async destroy(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string) {
    const rows = await tx`DELETE FROM registry_environment_namespaces WHERE id = ${remoteId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId}
      AND environment_id = ${scope.environmentId} RETURNING id`;
    return { removed: { namespaces: rows.length }, objects: [] };
  }
}
