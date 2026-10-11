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

  /**
   * Removes every table, row, vector, graph element, blob record and change event of the environment, then its
   * schema and its role. Only this environment's rows are named: every statement is keyed by its ID.
   */
  async destroy(tx: Bun.TransactionSQL, scope: EnvironmentScope, _remoteId: string) {
    const names = databaseEnvironmentIdentifiers(scope.environmentId); const environment = scope.environmentId;
    const count = async (query: Promise<unknown[]>) => (await query).length;
    // Keys first: once the rows are gone nothing else knows where the bytes are. An upload in progress has a key too.
    const objects = new Set<string>();
    for (const row of await tx<{ storage_key: string }[]>`SELECT o.storage_key FROM blob_objects o JOIN blob_buckets b ON b.id = o.bucket_id WHERE b.environment_id = ${environment}
      UNION SELECT t.storage_key FROM blob_transfers t JOIN blob_buckets b ON b.id = t.bucket_id WHERE b.environment_id = ${environment}`) objects.add(row.storage_key);
    const removed: Record<string, number> = {};
    await tx`DELETE FROM blob_usage WHERE environment_id = ${environment}`;
    await tx`DELETE FROM blob_events WHERE bucket_id IN (SELECT id FROM blob_buckets WHERE environment_id = ${environment})`;
    await tx`DELETE FROM blob_commands WHERE environment_id = ${environment}`;
    await tx`DELETE FROM blob_transfers WHERE bucket_id IN (SELECT id FROM blob_buckets WHERE environment_id = ${environment})`;
    removed.blob_objects = await count(tx`DELETE FROM blob_objects WHERE bucket_id IN (SELECT id FROM blob_buckets WHERE environment_id = ${environment}) RETURNING 1`);
    removed.blob_buckets = await count(tx`DELETE FROM blob_buckets WHERE environment_id = ${environment} RETURNING 1`);
    removed.change_events = await count(tx`DELETE FROM data_change_events WHERE environment_id = ${environment} RETURNING 1`);
    await tx`DELETE FROM data_change_pruned WHERE table_id IN (SELECT id FROM canonical_data_tables WHERE environment_id = ${environment})`;
    await tx`DELETE FROM canonical_data_constraints WHERE table_id IN (SELECT id FROM canonical_data_tables WHERE environment_id = ${environment})`;
    await tx`DELETE FROM canonical_data_commands WHERE environment_id = ${environment}`;
    await tx`DELETE FROM canonical_data_events WHERE table_id IN (SELECT id FROM canonical_data_tables WHERE environment_id = ${environment})`;
    removed.tables = await count(tx`DELETE FROM canonical_data_tables WHERE environment_id = ${environment} RETURNING 1`);
    removed.vector_points = await count(tx`DELETE FROM canonical_vector_points WHERE collection_id IN (SELECT id FROM canonical_vector_collections WHERE environment_id = ${environment}) RETURNING 1`);
    removed.vector_collections = await count(tx`DELETE FROM canonical_vector_collections WHERE environment_id = ${environment} RETURNING 1`);
    removed.graph_edges = await count(tx`DELETE FROM canonical_graph_edges WHERE environment_id = ${environment} RETURNING 1`);
    removed.graph_nodes = await count(tx`DELETE FROM canonical_graph_nodes WHERE environment_id = ${environment} RETURNING 1`);
    await tx`DELETE FROM engine_commands WHERE environment_id = ${environment}`;
    // The customer's own tables and every row in them. Identifiers are generated and validated UUID-derived names, never caller SQL.
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${names.schema}" CASCADE`);
    if ((await tx`SELECT 1 FROM pg_roles WHERE rolname = ${names.role}`).length) {
      await tx.unsafe(`DROP OWNED BY "${names.role}"`);
      await tx.unsafe(`DROP ROLE "${names.role}"`);
    }
    removed.blob_bytes_pending = objects.size;
    return { removed, objects: [...objects] };
  }
}
