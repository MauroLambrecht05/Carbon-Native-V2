import { PlatformFault, parseComponent, type EnvironmentScope } from '@carbon/contracts/platform';
import type { NativeEnvironmentDriver } from './NativeEnvironmentDriver.ts';

export function databaseEnvironmentIdentifiers(environmentId: string) {
  parseComponent('Id', environmentId);
  const name = `ce_${environmentId.replaceAll('-', '').toLowerCase()}`;
  if (!/^ce_[a-f0-9]{32}$/.test(name)) throw new Error('Invalid canonical database identifier');
  return { schema: name, role: name };
}
export class PostgresDatabaseEnvironmentDriver implements NativeEnvironmentDriver {
  async initialize(tx: Bun.TransactionSQL, scope: EnvironmentScope, _remoteId: string) {
    const names = databaseEnvironmentIdentifiers(scope.environmentId);
    const existing = await tx`SELECT 1 FROM pg_roles WHERE rolname = ${names.role} UNION ALL SELECT 1 FROM pg_namespace WHERE nspname = ${names.schema}`;
    if (existing.length) throw new PlatformFault('conflict', 'Native environment identifiers already exist; explicit recovery is required');
    // Identifiers are generated and validated UUID-derived names, never caller SQL.
    await tx.unsafe(`CREATE ROLE "${names.role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await tx.unsafe(`CREATE SCHEMA "${names.schema}"`);
    await tx.unsafe(`REVOKE ALL ON SCHEMA "${names.schema}" FROM PUBLIC`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA "${names.schema}" TO "${names.role}"`);
    await this.setState(tx, scope, _remoteId, 'active');
  }
  async setState(tx: Bun.TransactionSQL, scope: EnvironmentScope, _remoteId: string, state: 'active' | 'paused') {
    const names = databaseEnvironmentIdentifiers(scope.environmentId);
    await tx.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${names.schema}" TO "${names.role}"`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${names.schema}" GRANT SELECT ON TABLES TO "${names.role}"`);
    if (state === 'active') {
      await tx.unsafe(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${names.schema}" TO "${names.role}"`);
      await tx.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${names.schema}" TO "${names.role}"`);
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${names.schema}" GRANT INSERT, UPDATE, DELETE ON TABLES TO "${names.role}"`);
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${names.schema}" GRANT USAGE ON SEQUENCES TO "${names.role}"`);
    } else {
      await tx.unsafe(`REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${names.schema}" FROM "${names.role}"`);
      await tx.unsafe(`REVOKE USAGE ON ALL SEQUENCES IN SCHEMA "${names.schema}" FROM "${names.role}"`);
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${names.schema}" REVOKE INSERT, UPDATE, DELETE ON TABLES FROM "${names.role}"`);
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${names.schema}" REVOKE USAGE ON SEQUENCES FROM "${names.role}"`);
    }
  }
}
