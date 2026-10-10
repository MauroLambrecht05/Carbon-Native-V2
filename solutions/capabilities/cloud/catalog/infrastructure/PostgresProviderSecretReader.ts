import { PlatformFault, type EnvironmentScope } from '@carbon/contracts/platform';
import type { SecretProtector } from '../application/ports/SecretProtection.ts';

/**
 * Decrypts one environment secret for Cloud's own use, such as an identity provider's client secret during a token
 * exchange. The value is returned to the caller inside this process only; nothing here sends, stores or logs it.
 * Delivery of secrets to anything outside Cloud remains exclusive to worker leases.
 */
export class PostgresProviderSecretReader {
  constructor(private readonly sql: Bun.SQL, private readonly protector: SecretProtector) {}

  async read(scope: EnvironmentScope, name: string): Promise<string> {
    const row = (await this.sql<Record<string, any>[]>`SELECT s.id, v.id AS version_id, v.wrapping_key_id, v.envelope FROM environment_secrets s
      JOIN environment_secret_versions v ON v.secret_id = s.id AND v.version = s.current_version
      WHERE s.org_id = ${scope.orgId} AND s.project_id = ${scope.projectId} AND s.environment_id = ${scope.environmentId} AND s.name = ${name} AND s.state = 'active'`)[0];
    if (!row) throw new PlatformFault('conflict', 'The provider secret is missing or disabled');
    return this.protector.open({ wrappingKeyId: row.wrapping_key_id, envelope: row.envelope }, `environment-secret:${row.id}:version:${row.version_id}`);
  }
}
