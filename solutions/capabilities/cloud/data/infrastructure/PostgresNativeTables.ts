import { randomUUID } from 'node:crypto';
import { compileRowSelection } from './RowSelection.ts';
import { compileRowOrder } from './RowOrder.ts';
import { changesReferencedKey, planSchemaChange } from '../domain/SchemaChange.ts';
import { nativePrimaryKeyName, replaceNativePrimaryKey } from './NativePrimaryKey.ts';
import { assertManagedConstraints, refreshManagedConstraints, replaceManagedConstraint, type ForeignTarget } from './ManagedConstraints.ts';
import type { DataConstraint, DataSchemaChange } from '@carbon/contracts/platform';
import type { DataChangesQuery, DataChangesResult, DataQuery } from '@carbon/contracts/platform';
import { postgresArray } from './PostgresParameters.ts';
import { applyNativeImport } from './NativeImportExecutor.ts';
import { importExecutionDigest } from '../domain/ImportExecution.ts';
import type { DataImportExecution, DataImportExecutionResult } from '@carbon/contracts/platform';
import type { DataRowSelection } from '@carbon/contracts/platform';
import { PlatformFault, parseComponent, canonicalDataRequest, dataPermission, dataTablePageOrder, type Permission, type DataMutation, type DataCommandReceipt, type DataTablesQuery } from '@carbon/contracts/platform';
import { bodyDigest } from '@carbon/identity';
import { databaseEnvironmentIdentifiers } from '@carbon/catalog';
import { identifier, pgTypes, validateDefinition, validatePolicies, validateValue, type NativeColumn, type NativeDefinition, type NativePolicySet } from '../domain/NativeTable.ts';
import type { NativeDataAuthority, NativeRowAccess, NativeRow, NativeTableRecord, NativeTablesRepository } from '../application/ports/NativeTables.ts';

function physical(id: string): string { parseComponent('Id', id); return `"ct_${id.replaceAll('-', '').toLowerCase()}"`; }
function literal(value: string): string { return "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'"; }
function defaultSql(column: NativeColumn): string {
  const value = column.default;
  if (!value) return '';
  if (value.kind === 'uuid') return ' DEFAULT pg_catalog.gen_random_uuid()';
  if (value.kind === 'now') return ' DEFAULT pg_catalog.now()';
  if (!('value' in value)) throw new PlatformFault('validation', 'Invalid column default');
  if (value.value === null) return ' DEFAULT NULL';
  const serialized = column.type === 'json' || column.type === 'jsonb' ? JSON.stringify(value.value)
    : column.type.endsWith('[]') ? undefined : String(value.value);
  if (serialized !== undefined) return ` DEFAULT ${literal(serialized)}::${pgTypes[column.type]}`;
  const itemType = column.type === 'text[]' ? 'text' : 'bigint';
  return ` DEFAULT ARRAY[${(value.value as unknown[]).map(item => `${literal(String(item))}::${itemType}`).join(',')}]::${pgTypes[column.type]}`;
}
function selected(columns: readonly NativeColumn[]): string {
  return ['_carbon_id::text', '_carbon_revision::text', ...columns.map(column => {
    const name = identifier(column.name);
    if (['integer', 'decimal', 'uuid'].includes(column.type)) return `${name}::text AS ${name}`;
    if (column.type === 'integer[]') return `${name}::text[] AS ${name}`;
    return name;
  })].join(', ');
}
function rowResult(row: Record<string, unknown>, columns: readonly NativeColumn[]): NativeRow {
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column.name];
    values[column.name] = column.type === 'timestamp' && value instanceof Date ? value.toISOString() : value;
  }
  return { id: row._carbon_id as string, revision: row._carbon_revision as string, values };
}

/** Internal persistence adapter. No raw SQL or caller-supplied policy SQL enters this class.
 * Transport verification and live authorization are required through NativeDataAuthority. */
export class PostgresNativeTables implements NativeTablesRepository {
  constructor(private readonly sql: Bun.SQL, private readonly transaction?: Bun.TransactionSQL) {}
  private transact<T>(work: (tx: Bun.TransactionSQL) => Promise<T>): Promise<T> {
    return this.transaction ? work(this.transaction) : this.sql.begin(work) as Promise<T>;
  }
  async command(authority: NativeDataAuthority, input: DataMutation): Promise<DataCommandReceipt> {
    const command = parseComponent('DataMutation', structuredClone(input));
    const digest = bodyDigest(canonicalDataRequest({ scope: authority.scope, bindingId: authority.bindingId, command }));
    const permission = dataPermission(command.kind);
    return this.transact(async tx => {
      await this.environment(tx, authority, permission);
      const actor = authority.principal;
      const lock = JSON.stringify([actor.kind, actor.id, command.commandId]);
      await tx`SELECT pg_advisory_xact_lock(1128354374, hashtext(${lock}))`;
      const existing = await tx`SELECT request_digest, result FROM public.canonical_data_commands WHERE principal_kind = ${actor.kind} AND principal_id = ${actor.id} AND command_id = ${command.commandId}`;
      if (existing.length) {
        if (existing[0].request_digest !== digest) throw new PlatformFault('conflict', 'Command ID was used for a different request');
        await this.authorizeAgain(authority, permission);
        return parseComponent('DataCommandReceipt', existing[0].result);
      }
      const bound = new PostgresNativeTables(this.sql, tx);
      let receipt: DataCommandReceipt = { commandId: command.commandId, tableId: command.tableId };
      switch (command.kind) {
        case 'table.create': {
          const table = await bound.create(authority, command.tableId, command.definition);
          receipt = { ...receipt, revision: table.revision }; break;
        }
        case 'table.policies': {
          const table = await bound.replacePolicies(authority, command.tableId, command.revision, command.policies);
          receipt = { ...receipt, revision: table.revision }; break;
        }
        case 'table.alter': {
          const table = await bound.alter(authority, command.tableId, command.revision, command.change, command.confirmation);
          receipt = { ...receipt, revision: table.revision }; break;
        }
        case 'row.insert': {
          const table = await bound.table(tx, authority, command.tableId);
          if (table.revision !== command.revision) throw new PlatformFault('conflict', 'Table revision changed');
          const row = await bound.insert(authority, command.tableId, command.access, command.values);
          receipt = { ...receipt, rowId: row.id, revision: row.revision }; break;
        }
        case 'row.update': {
          const row = await bound.update(authority, command.tableId, command.access, command.rowId, command.revision, command.values);
          receipt = { ...receipt, rowId: row.id, revision: row.revision }; break;
        }
        case 'row.delete': await bound.delete(authority, command.tableId, command.access, command.rowId, command.revision); receipt = { ...receipt, rowId: command.rowId }; break;
      }
      const scope = authority.scope;
      await tx`INSERT INTO public.canonical_data_commands (principal_kind, principal_id, command_id, org_id, project_id, environment_id, binding_id, table_id, request_digest, result)
        VALUES (${actor.kind}, ${actor.id}, ${command.commandId}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${authority.bindingId}, ${command.tableId}, ${digest}, ${JSON.stringify(receipt)}::text::jsonb)`;
      return parseComponent('DataCommandReceipt', receipt);
    });
  }
  private async environment(tx: Bun.TransactionSQL, authority: NativeDataAuthority, permission: Permission) {
    parseComponent('EnvironmentScope', authority.scope); parseComponent('Id', authority.bindingId);
    parseComponent('Principal', authority.principal); parseComponent('Id', authority.requestId);
    const principal = authority.principal;
    if (!((principal.kind === 'account' && principal.audience === 'dashboard') || (principal.kind === 'service_account' && principal.audience === 'automation') || (principal.kind === 'app_user' && principal.audience === 'app'))
      || !await authority.permit(permission)) throw new PlatformFault('forbidden', 'Data access is not authorized');
    await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '5s'`;
    const scope = authority.scope;
    const rows = await tx`SELECT id, state FROM public.platform_environments WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId}
      AND environment_id = ${scope.environmentId} AND binding_id = ${authority.bindingId} FOR SHARE`;
    if (!rows.length) throw new PlatformFault('not_found', 'Environment resource not found');
    if (permission !== 'data.read' && permission !== 'metadata.read' && rows[0].state !== 'active') throw new PlatformFault('conflict', 'Environment is paused');
    return rows[0];
  }
  /** Worker primitive, exposed only through the lease-bound import protocol. */
  async applyImport(authority: NativeDataAuthority, input: DataImportExecution): Promise<DataImportExecutionResult> {
    if (authority.principal.kind !== 'account') throw new PlatformFault('forbidden', 'Account import authority is required');
    const command = parseComponent('DataImportExecution', structuredClone(input));
    const scope = authority.scope;
    const digest = importExecutionDigest(scope, authority.bindingId, command);
    return this.transact(async tx => {
      await this.environment(tx, authority, 'data.write');
      const actor = authority.principal; const lock = JSON.stringify([actor.kind, actor.id, command.commandId]);
      await tx`SELECT pg_advisory_xact_lock(1128354374, hashtext(${lock}))`;
      const existing = await tx`SELECT request_digest, result FROM public.canonical_data_commands WHERE principal_kind = ${actor.kind} AND principal_id = ${actor.id} AND command_id = ${command.commandId}`;
      if (existing.length) {
        if (existing[0].request_digest !== digest) throw new PlatformFault('conflict', 'Command ID was used for a different request');
        await this.authorizeAgain(authority, 'data.write');
        return parseComponent('DataImportExecutionResult', existing[0].result);
      }
      const bound = new PostgresNativeTables(this.sql, tx);
      const result = await bound.rows(authority, command.tableId, command.access, 'data.write', async (rowTx, table, target) =>
        applyNativeImport(rowTx, target, table, command, values => this.values(values, table.definition.columns)));
      await this.audit(tx, authority, command.tableId, 'rows.import', { revision: result.revision, total: result.total,
        inserted: result.inserted, updated: result.updated, skipped: result.skipped, failed: result.failed, atomic: command.input.atomic, conflict: command.input.conflict });
      await tx`INSERT INTO public.canonical_data_commands (principal_kind, principal_id, command_id, org_id, project_id, environment_id, binding_id, table_id, request_digest, result)
        VALUES (${actor.kind}, ${actor.id}, ${command.commandId}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${authority.bindingId}, ${command.tableId}, ${digest}, ${JSON.stringify(result)}::text::jsonb)`;
      return result;
    });
  }
  async importStatus(authority: NativeDataAuthority, input: DataImportExecution): Promise<DataImportExecutionResult | null> {
    if (authority.principal.kind !== 'account') throw new PlatformFault('forbidden', 'Account import authority is required');
    const command = parseComponent('DataImportExecution', structuredClone(input));
    const digest = importExecutionDigest(authority.scope, authority.bindingId, command);
    return this.transact(async tx => {
      await this.environment(tx, authority, 'metadata.read');
      const actor = authority.principal; const lock = JSON.stringify([actor.kind, actor.id, command.commandId]);
      // Reconciliation serializes with a possibly still-running old execution.
      await tx`SELECT pg_advisory_xact_lock(1128354374, hashtext(${lock}))`;
      const scope = authority.scope;
      const rows = await tx`SELECT request_digest, result FROM public.canonical_data_commands WHERE principal_kind = ${actor.kind} AND principal_id = ${actor.id}
        AND command_id = ${command.commandId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
        AND binding_id = ${authority.bindingId} AND table_id = ${command.tableId}`;
      if (rows.length && rows[0].request_digest !== digest) throw new PlatformFault('conflict', 'Import receipt belongs to a different command');
      await this.authorizeAgain(authority, 'metadata.read');
      return rows.length ? parseComponent('DataImportExecutionResult', rows[0].result) : null;
    });
  }
  private async table(tx: Bun.TransactionSQL, authority: NativeDataAuthority, id: string, lock: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<NativeTableRecord> {
    parseComponent('Id', id);
    const scope = authority.scope;
    const rows = await tx.unsafe(`SELECT id, revision::text, definition FROM public.canonical_data_tables WHERE id = $1 AND org_id = $2 AND project_id = $3 AND environment_id = $4 FOR ${lock}`,
      [id, scope.orgId, scope.projectId, scope.environmentId]);
    if (!rows.length) throw new PlatformFault('not_found', 'Table not found');
    return { id: rows[0].id, revision: rows[0].revision, definition: validateDefinition(rows[0].definition) };
  }
  private async audit(tx: Bun.TransactionSQL, authority: NativeDataAuthority, tableId: string, action: string, detail: Record<string, unknown>) {
    await tx`INSERT INTO public.canonical_data_events (id, table_id, actor, action, request_id, detail)
      VALUES (${randomUUID()}, ${tableId}, ${JSON.stringify(authority.principal)}::text::jsonb, ${action}, ${authority.requestId}, ${JSON.stringify(detail)}::text::jsonb)`;
  }
  private async authorizeAgain(authority: NativeDataAuthority, permission: Permission) {
    if (!await authority.permit(permission)) throw new PlatformFault('forbidden', 'Data authority is no longer current');
  }
  async list(authority: NativeDataAuthority, input: DataTablesQuery) {
    const query = parseComponent('DataTablesQuery', input);
    const order = dataTablePageOrder(query);
    if (!['account','service_account'].includes(authority.principal.kind)) throw new PlatformFault('forbidden', 'Management metadata authority is required');
    return this.transact(async tx => {
      await this.environment(tx, authority, 'metadata.read');
      const scope = authority.scope; const limit = query.limit ?? 50;
      const comparison = order.descending ? '<' : '>'; const direction = order.descending ? 'DESC' : 'ASC';
      const key = order.byName ? '(name COLLATE "C", id)' : 'id';
      const anchor = order.byName ? '($6::text COLLATE "C", $5::uuid)' : '$5::uuid';
      const rows = await tx.unsafe(`SELECT id, revision::text, name, jsonb_array_length(definition->'columns') AS "columnCount",
        (definition->'policies'->>'enabled')::boolean AS "policiesEnabled" FROM public.canonical_data_tables
        WHERE org_id = $1 AND project_id = $2 AND environment_id = $3
          AND strpos(lower(name COLLATE "C"), lower($4::text COLLATE "C")) > 0
          AND ($5::uuid IS NULL OR ${key} ${comparison} ${anchor})
          ${order.byName ? '' : 'AND $6::text IS NULL'}
        ORDER BY ${order.byName ? 'name COLLATE "C" ' + direction + ', ' : ''}id ${direction} LIMIT $7`,
        [scope.orgId, scope.projectId, scope.environmentId, query.name ?? '', query.afterId ?? null, query.afterName ?? null, limit + 1]);
      const tables = rows.slice(0, limit);
      await this.authorizeAgain(authority, 'metadata.read');
      const more = rows.length > limit;
      return parseComponent('DataTablesResult', { tables, nextAfterId: more ? tables.at(-1)!.id : null,
        ...(more && order.byName ? { nextAfterName: tables.at(-1)!.name } : {}) });
    });
  }
  async get(authority: NativeDataAuthority, id: string): Promise<NativeTableRecord> {
    if (!['account','service_account'].includes(authority.principal.kind)) throw new PlatformFault('forbidden', 'Management metadata authority is required');
    return this.transact(async tx => {
      await this.environment(tx, authority, 'metadata.read');
      const table = await this.table(tx, authority, id);
      await this.authorizeAgain(authority, 'metadata.read');
      return parseComponent('DataTable', table);
    });
  }
  /** Resolves and checks what a foreign key points at: a table in this environment whose primary key has the column's type. */
  private async foreignTarget(tx: Bun.TransactionSQL, authority: NativeDataAuthority, id: string, definition: NativeDefinition, constraint: DataConstraint): Promise<ForeignTarget | undefined> {
    if (constraint.kind !== 'foreign-key') return undefined;
    const referenced = constraint.references.tableId.toLowerCase() === id.toLowerCase() ? definition : (await this.table(tx, authority, constraint.references.tableId)).definition;
    const key = referenced.columns.find(column => column.name === referenced.primaryKey);
    if (!key) throw new PlatformFault('validation', 'The referenced table has no primary key');
    if (definition.columns.find(column => column.name === constraint.columns[0])!.type !== key.type) throw new PlatformFault('validation', 'The column type does not match the referenced primary key');
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
    return { target: `"${names.schema}".${physical(constraint.references.tableId)}`, column: key.name };
  }
  /** Foreign keys in other tables (and this one) that point at this table's primary key. */
  private async inbound(tx: Bun.TransactionSQL, authority: NativeDataAuthority, id: string): Promise<string[]> {
    const rows = await tx`SELECT c.table_id, c.constraint_id FROM public.canonical_data_constraints c JOIN public.canonical_data_tables t ON t.id = c.table_id
      WHERE t.environment_id = ${authority.scope.environmentId} AND c.descriptor->>'kind' = 'foreign-key' AND lower(c.descriptor->'references'->>'tableId') = ${id.toLowerCase()}
      ORDER BY c.table_id, c.constraint_id LIMIT 32`;
    return rows.map((row: { table_id: string; constraint_id: string }) => `inbound-foreign-key:${row.table_id}:${row.constraint_id}`);
  }
  async preview(authority: NativeDataAuthority, id: string, change: DataSchemaChange) {
    if (!['account','service_account'].includes(authority.principal.kind)) throw new PlatformFault('forbidden', 'Management metadata authority is required');
    return this.transact(async tx => {
      await this.environment(tx, authority, 'metadata.read'); const table = await this.table(tx, authority, id);
      const plan = planSchemaChange(table.definition, change);
      if (change.kind === 'constraint.set') await this.foreignTarget(tx, authority, id, plan.definition, change.constraint);
      // Impact across tables: a change to the key other tables point at is shown with those tables and cannot be applied.
      const inbound = changesReferencedKey(table.definition, change) ? await this.inbound(tx, authority, id) : [];
      await this.authorizeAgain(authority, 'metadata.read');
      return parseComponent('DataSchemaPreview', { tableId: id, revision: table.revision, ...plan, dependencies: [...plan.dependencies, ...inbound], blocked: inbound.length > 0 });
    });
  }
  async alter(authority: NativeDataAuthority, id: string, revision: string, change: DataSchemaChange, confirmation?: string): Promise<NativeTableRecord> {
    parseComponent('Revision', revision);
    change = parseComponent('DataSchemaChange', structuredClone(change));
    if (!['account','service_account'].includes(authority.principal.kind)) throw new PlatformFault('forbidden', 'Management configuration authority is required');
    return this.transact(async tx => {
      await this.environment(tx, authority, 'resources.configure'); const table = await this.table(tx, authority, id, 'UPDATE');
      if (table.revision !== revision) throw new PlatformFault('conflict', 'Table revision changed');
      const plan = planSchemaChange(table.definition, change);
      if (plan.destructive && confirmation !== table.definition.name) throw new PlatformFault('validation', 'Confirm the current table name for a destructive schema change');
      if (changesReferencedKey(table.definition, change) && (await this.inbound(tx, authority, id)).length) throw new PlatformFault('conflict', 'Other tables reference this key; remove their foreign keys first');
      const foreign = change.kind === 'constraint.set' ? await this.foreignTarget(tx, authority, id, plan.definition, change.constraint) : undefined;
      const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const target = `"${names.schema}".${physical(id)}`;
      await assertManagedConstraints(tx, target, id, table.definition);
      if (change.kind === 'primary-key') await replaceNativePrimaryKey(tx, target, id, table.definition.primaryKey, plan.definition.primaryKey);
      else if (change.kind === 'constraint.set' || change.kind === 'constraint.delete') {
        const constraintId = change.kind === 'constraint.set' ? change.constraint.id : change.constraintId;
        await replaceManagedConstraint(tx, names.schema, target, id, plan.definition,
          table.definition.constraints?.find(constraint => constraint.id === constraintId), change.kind === 'constraint.set' ? change.constraint : undefined, foreign);
      }
      else if (change.kind !== 'rename') {
        // Rebuild managed policies and the row-size check atomically around the DDL.
        await this.applyPolicies(tx, authority, id, { ...table.definition, policies: { enabled: false, rules: [] } });
        if (change.kind === 'column.drop') {
          const dependencies = await tx`SELECT 1 FROM pg_attribute a WHERE a.attrelid = ${target}::regclass AND a.attname = ${change.name}
            AND (EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = a.attrelid AND a.attnum = ANY(c.conkey) AND c.conname <> 'carbon_row_size')
              OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_index i ON i.indexrelid = d.objid
                WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = a.attrelid AND d.refobjsubid = a.attnum))`;
          if (dependencies.length) throw new PlatformFault('conflict', 'Column has native constraints or indexes requiring review');
        }
        await tx.unsafe(`ALTER TABLE ${target} DROP CONSTRAINT carbon_row_size`);
        if (change.kind === 'column.add') {
          const column = change.column;
          await tx.unsafe(`ALTER TABLE ${target} ADD COLUMN ${identifier(column.name)} ${pgTypes[column.type]}${column.nullable ? '' : ' NOT NULL'}${defaultSql(column)}`);
        } else if (change.kind === 'column.drop') await tx.unsafe(`ALTER TABLE ${target} DROP COLUMN ${identifier(change.name)} RESTRICT`);
        else {
          const before = table.definition.columns.find(column => column.name === change.original)!; const column = change.column;
          if (before.name !== column.name) await tx.unsafe(`ALTER TABLE ${target} RENAME COLUMN ${identifier(before.name)} TO ${identifier(column.name)}`);
          const name = identifier(column.name);
          await tx.unsafe(`ALTER TABLE ${target} ALTER COLUMN ${name} DROP DEFAULT`);
          if (before.type !== column.type) await tx.unsafe(`ALTER TABLE ${target} ALTER COLUMN ${name} TYPE ${pgTypes[column.type]} USING ${name}::${pgTypes[column.type]}`);
          await tx.unsafe(`ALTER TABLE ${target} ALTER COLUMN ${name} ${column.nullable ? 'DROP' : 'SET'} NOT NULL`);
          const defaultClause = defaultSql(column);
          if (defaultClause) await tx.unsafe(`ALTER TABLE ${target} ALTER COLUMN ${name} SET${defaultClause}`);
        }
        await tx.unsafe(`ALTER TABLE ${target} ADD CONSTRAINT carbon_row_size CHECK (pg_catalog.octet_length(pg_catalog.row_to_json(ROW(${plan.definition.columns.map(column => identifier(column.name)).join(',')}))::text) <= 65536)`);
        await this.applyPolicies(tx, authority, id, plan.definition);
      }
      await refreshManagedConstraints(tx, target, id, plan.definition);
      const rows = await tx`UPDATE public.canonical_data_tables SET name = ${plan.definition.name}, definition = ${JSON.stringify(plan.definition)}::text::jsonb,
        revision = revision + 1, updated_at = now() WHERE id = ${id} RETURNING revision::text`;
      await this.authorizeAgain(authority, 'resources.configure');
      await this.audit(tx, authority, id, 'table.alter', { revision: rows[0].revision, kind: change.kind, destructive: plan.destructive,
        ...(change.kind === 'constraint.set' ? { constraintId: change.constraint.id } : change.kind === 'constraint.delete' ? { constraintId: change.constraintId } : {}) });
      return { id, revision: rows[0].revision, definition: plan.definition };
    });
  }
  private async applyPolicies(tx: Bun.TransactionSQL, authority: NativeDataAuthority, id: string, definition: NativeDefinition) {
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
    const target = `"${names.schema}".${physical(id)}`;
    // Always retain native RLS. A disabled policy set denies application access;
    // future administrative access must use a separately audited authority path.
    await tx.unsafe(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY`);
    await tx.unsafe(`ALTER TABLE ${target} FORCE ROW LEVEL SECURITY`);
    const policies = await tx`SELECT p.polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${names.schema} AND c.relname = ${'ct_' + id.replaceAll('-', '').toLowerCase()}`;
    for (const policy of policies) {
      if (!/^carbon_(scope|[a-f0-9]{32}_(select|insert|update|delete))$/.test(policy.polname)) throw new PlatformFault('conflict', 'Unexpected native policy requires review');
      await tx.unsafe(`DROP POLICY "${policy.polname}" ON ${target}`);
    }
    const scope = authority.scope;
      const guard = `pg_catalog.current_setting('carbon.org_id', true) = ${literal(scope.orgId.toLowerCase())} AND pg_catalog.current_setting('carbon.project_id', true) = ${literal(scope.projectId.toLowerCase())} AND pg_catalog.current_setting('carbon.environment_id', true) = ${literal(scope.environmentId.toLowerCase())}`;
    await tx.unsafe(`CREATE POLICY carbon_scope ON ${target} AS RESTRICTIVE FOR ALL TO "${names.role}" USING (${guard}) WITH CHECK (${guard})`);
    if (!definition.policies.enabled) return;
    for (const rule of definition.policies.rules) for (const operation of rule.operations) {
      const expression = rule.kind === 'public-read' ? 'true'
        : `NULLIF(pg_catalog.current_setting('carbon.user_id', true), '') IS NOT NULL AND ${identifier(rule.ownerColumn)}::text = pg_catalog.current_setting('carbon.user_id', true)`;
      const clauses = operation === 'insert' ? `WITH CHECK (${expression})` : operation === 'update' ? `USING (${expression}) WITH CHECK (${expression})` : `USING (${expression})`;
      await tx.unsafe(`CREATE POLICY "carbon_${rule.id.replaceAll('-', '').toLowerCase()}_${operation}" ON ${target} FOR ${operation.toUpperCase()} TO "${names.role}" ${clauses}`);
    }
  }
  async create(authority: NativeDataAuthority, id: string, input: NativeDefinition): Promise<NativeTableRecord> {
    parseComponent('Id', id); const definition = validateDefinition(structuredClone(input));
    if (!['account','service_account'].includes(authority.principal.kind)) throw new PlatformFault('forbidden', 'Management configuration authority is required');
    return this.transact(async tx => {
      const environment = await this.environment(tx, authority, 'resources.configure');
      const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
      const foreign = new Map<string, ForeignTarget | undefined>();
      for (const constraint of definition.constraints ?? []) foreign.set(constraint.id, await this.foreignTarget(tx, authority, id, definition, constraint));
      const columns = definition.columns.map(column => `${identifier(column.name)} ${pgTypes[column.type]}${column.nullable ? '' : ' NOT NULL'}${defaultSql(column)}`);
      if (definition.primaryKey) columns.push(`CONSTRAINT ${identifier(nativePrimaryKeyName(id))} UNIQUE (${identifier(definition.primaryKey)})`);
      columns.push(`CONSTRAINT carbon_row_size CHECK (pg_catalog.octet_length(pg_catalog.row_to_json(ROW(${definition.columns.map(column => identifier(column.name)).join(',')}))::text) <= 65536)`);
      // Native identifiers are opaque stable IDs; user-visible names are catalog data.
      await tx.unsafe(`CREATE TABLE "${names.schema}".${physical(id)} (_carbon_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), _carbon_revision bigint NOT NULL DEFAULT 1 CHECK (_carbon_revision > 0), ${columns.join(', ')})`);
      await this.applyPolicies(tx, authority, id, definition);
      const scope = authority.scope;
      // Every change to the table's rows is captured from here on, in the same transaction as the change, whatever makes it.
      await tx.unsafe(`CREATE TRIGGER carbon_capture AFTER INSERT OR UPDATE OR DELETE ON "${names.schema}".${physical(id)} FOR EACH ROW EXECUTE FUNCTION public.carbon_capture_change(${literal(id)})`);
      await tx`INSERT INTO public.canonical_data_tables (id, resource_id, org_id, project_id, environment_id, name, definition)
        VALUES (${id}, ${environment.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${definition.name}, ${JSON.stringify(definition)}::text::jsonb)`;
      for (const constraint of definition.constraints ?? []) await replaceManagedConstraint(tx, names.schema, `"${names.schema}".${physical(id)}`, id, definition, undefined, constraint, foreign.get(constraint.id));
      await this.authorizeAgain(authority, 'resources.configure');
      await this.audit(tx, authority, id, 'table.create', { revision: '1' });
      return { id, revision: '1', definition };
    });
  }
  async replacePolicies(authority: NativeDataAuthority, id: string, revision: string, input: NativePolicySet): Promise<NativeTableRecord> {
    parseComponent('Revision', revision);
    const policies = structuredClone(input);
    if (!['account','service_account'].includes(authority.principal.kind)) throw new PlatformFault('forbidden', 'Management configuration authority is required');
    return this.transact(async tx => {
      await this.environment(tx, authority, 'resources.configure');
      const table = await this.table(tx, authority, id, 'UPDATE');
      if (table.revision !== revision) throw new PlatformFault('conflict', 'Table revision changed');
      const definition = { ...table.definition, policies: validatePolicies(policies, table.definition.columns) };
      await this.applyPolicies(tx, authority, id, definition);
      const rows = await tx`UPDATE public.canonical_data_tables SET definition = ${JSON.stringify(definition)}::text::jsonb, revision = revision + 1, updated_at = now() WHERE id = ${id} RETURNING revision::text`;
      await this.authorizeAgain(authority, 'resources.configure');
      await this.audit(tx, authority, id, 'table.policies', { revision: rows[0].revision });
      return { id, revision: rows[0].revision, definition };
    });
  }
  private async rows<T>(authority: NativeDataAuthority, id: string, access: NativeRowAccess, permission: 'data.read' | 'data.write', work: (tx: Bun.TransactionSQL, table: NativeTableRecord, target: string) => Promise<T>): Promise<T> {
    let userId: string | undefined;
    if (access.mode === 'application' && authority.principal.kind === 'app_user') userId = authority.principal.id;
    else if (access.mode === 'policy-preview' && authority.principal.kind === 'account') userId = access.userId;
    else throw new PlatformFault('forbidden', 'Verified application identity or account policy preview is required');
    if (userId !== undefined) parseComponent('Id', userId);
    return this.transact(async tx => {
      await this.environment(tx, authority, permission);
      const table = await this.table(tx, authority, id);
      const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
      const roles = await tx`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = ${names.role}`;
      if (roles.length !== 1 || Object.values(roles[0]).some(value => value !== false)) throw new PlatformFault('unavailable', 'Native role configuration requires review');
      const scope = authority.scope;
      await tx`SELECT set_config('carbon.org_id', ${scope.orgId.toLowerCase()}, true), set_config('carbon.project_id', ${scope.projectId.toLowerCase()}, true),
        set_config('carbon.environment_id', ${scope.environmentId.toLowerCase()}, true), set_config('carbon.user_id', ${userId?.toLowerCase() ?? ''}, true)`;
      await tx.unsafe(`SET LOCAL search_path TO pg_catalog, "${names.schema}"`);
      await tx.unsafe(`SET LOCAL ROLE "${names.role}"`);
      const result = await work(tx, table, `"${names.schema}".${physical(id)}`);
      await tx.unsafe('RESET ROLE');
      await this.authorizeAgain(authority, permission);
      await this.audit(tx, authority, id, permission === 'data.read' ? 'rows.read' : 'rows.write', { mode: access.mode, ...(access.mode === 'policy-preview' ? { previewUserId: userId ?? null } : {}) });
      return result;
    });
  }
  async query(authority: NativeDataAuthority, id: string, access: NativeRowAccess, limit = 100, afterId?: string, selection: DataRowSelection = {}): Promise<readonly NativeRow[]> {
    return (await this.queryPage(authority, { kind: 'rows.query', tableId: id, access, limit, afterId, ...selection })).rows;
  }
  async queryPage(authority: NativeDataAuthority, input: DataQuery) {
    const query = parseComponent('DataQuery', structuredClone(input)); const limit = query.limit ?? 100;
    return this.rows(authority, query.tableId, query.access, 'data.read', async (tx, table, target) => {
      const parameters: unknown[] = [query.afterId ?? null, limit + 1];
      const selection = compileRowSelection({ filters: query.filters, columns: query.columns, selectedIds: query.selectedIds }, table.definition.columns, parameters);
      const order = compileRowOrder(query, table.definition, table.revision, parameters);
      const records = await tx.unsafe(`SELECT ${selected(selection.columns)}${order.select} FROM ${target} WHERE (${order.where}) AND (${selection.where}) ORDER BY ${order.order} LIMIT $2`, parameters);
      const page = records.slice(0, limit); const last = page.at(-1); const more = records.length > limit;
      const rows = page.map((row: Record<string, unknown>) => rowResult(row, selection.columns));
      if (Buffer.byteLength(JSON.stringify(rows)) > 2097152) throw new PlatformFault('validation', 'Row result exceeds the byte limit; use a smaller page');
      const nextSort = more && query.sort ? { value: last._carbon_sort_value instanceof Date ? last._carbon_sort_value.toISOString() : last._carbon_sort_value,
        sqlNull: last._carbon_sort_null, revision: table.revision } : undefined;
      return parseComponent('DataQueryResult', { tableId: query.tableId, rows, nextAfterId: more ? last._carbon_id : null, ...(nextSort ? { nextSort } : {}) });
    });
  }
  /**
   * Change notifications for one table after a cursor. Order is commit order, and only changes below the oldest
   * transaction still running are returned, so nothing can later appear behind a cursor. Each event is delivered only to
   * a reader who could see the row when it changed. A cursor from before a schema or policy change, or from before the
   * feed's retention, cannot be continued: the reader is told to reset.
   */
  async changes(authority: NativeDataAuthority, input: DataChangesQuery): Promise<DataChangesResult> {
    const query = parseComponent('DataChangesQuery', structuredClone(input)); const limit = query.limit ?? 100; const access = query.access;
    let userId: string | undefined;
    if (access.mode === 'application' && authority.principal.kind === 'app_user') userId = authority.principal.id;
    else if (access.mode === 'policy-preview' && authority.principal.kind === 'account') userId = access.userId;
    else throw new PlatformFault('forbidden', 'Verified application identity or account policy preview is required');
    if (userId !== undefined) parseComponent('Id', userId);
    return this.transact(async tx => {
      await this.environment(tx, authority, 'data.read'); const table = await this.table(tx, authority, query.tableId);
      const horizon = (await tx<{ xmin: string }[]>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`)[0]!.xmin;
      const head = async () => {
        const last = (await tx<{ tx: string; seq: string }[]>`SELECT transaction_id::text AS tx, sequence::text AS seq FROM public.data_change_events
          WHERE table_id = ${table.id} AND transaction_id < ${horizon}::xid8 ORDER BY transaction_id DESC, sequence DESC LIMIT 1`)[0];
        return `${table.revision}.${last?.tx ?? '0'}.${last?.seq ?? '0'}`;
      };
      const answer = async (result: Omit<DataChangesResult, 'tableId'>) => { await this.authorizeAgain(authority, 'data.read'); return parseComponent('DataChangesResult', { tableId: table.id, ...result }); };
      // No cursor: start from now. The reader loads the table, then follows from here.
      if (!query.cursor) return answer({ events: [], nextCursor: await head(), reset: false });
      const [revision, after, sequence] = query.cursor.split('.') as [string, string, string];
      const pruned = (await tx<{ tx: string; seq: string }[]>`SELECT transaction_id::text AS tx, sequence::text AS seq FROM public.data_change_pruned WHERE table_id = ${table.id}`)[0];
      const missed = pruned !== undefined && (BigInt(after) < BigInt(pruned.tx) || (BigInt(after) === BigInt(pruned.tx) && BigInt(sequence) < BigInt(pruned.seq)));
      // Who may see what is decided by the table's policies, and those are part of its revision.
      if (revision !== table.revision || missed) return answer({ events: [], nextCursor: await head(), reset: true });
      const rows = await tx<Record<string, any>[]>`SELECT transaction_id::text AS tx, sequence::text AS seq, row_id, operation, row_revision::text AS row_revision, visibility, occurred_at FROM public.data_change_events
        WHERE table_id = ${table.id} AND transaction_id < ${horizon}::xid8 AND (transaction_id, sequence) > (${after}::xid8, ${sequence}::bigint) ORDER BY transaction_id, sequence LIMIT 2000`;
      const events: DataChangesResult['events'][number][] = []; let position = query.cursor; const reader = userId?.toLowerCase();
      for (const row of rows) {
        if (events.length === limit) break;
        position = `${table.revision}.${row.tx}.${row.seq}`;
        // A change to a row this reader could not see is skipped, but the cursor still moves past it.
        if (row.visibility.public !== true && !(reader !== undefined && (row.visibility.owners as string[]).includes(reader))) continue;
        events.push({ cursor: position, operation: row.operation, rowId: row.row_id, revision: row.row_revision ?? null, occurredAt: row.occurred_at.toISOString() });
      }
      return answer({ events, nextCursor: position, reset: false });
    });
  }
  /** Removes change events older than the retention and records how far each table's feed was cut. */
  async pruneChanges(retentionHours = 72): Promise<number> {
    const removed = await this.sql`WITH gone AS (DELETE FROM public.data_change_events WHERE occurred_at < now() - make_interval(hours => ${retentionHours})
        AND transaction_id < pg_snapshot_xmin(pg_current_snapshot()) RETURNING table_id, transaction_id, sequence),
      cut AS (INSERT INTO public.data_change_pruned (table_id, transaction_id, sequence)
        SELECT DISTINCT ON (table_id) table_id, transaction_id, sequence FROM gone ORDER BY table_id, transaction_id DESC, sequence DESC
        ON CONFLICT (table_id) DO UPDATE SET transaction_id = EXCLUDED.transaction_id, sequence = EXCLUDED.sequence, pruned_at = now() RETURNING 1)
      SELECT (SELECT count(*) FROM gone)::integer AS removed, (SELECT count(*) FROM cut)::integer AS tables`;
    return removed[0].removed;
  }
  private values(input: Record<string, unknown>, columns: readonly NativeColumn[]) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 100) throw new PlatformFault('validation', 'Invalid row values');
    const values = Object.entries(input).map(([key, value]) => {
      const column = columns.find(column => column.name === key);
      if (!column) throw new PlatformFault('validation', 'Unknown row column');
      validateValue(column, value);
      return { column, value: value !== null && ['json', 'jsonb'].includes(column.type) ? JSON.stringify(value)
        : Array.isArray(value) ? postgresArray(value) : value };
    });
    if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new PlatformFault('validation', 'Row input exceeds the byte limit');
    return values;
  }
  async insert(authority: NativeDataAuthority, id: string, access: NativeRowAccess, input: Record<string, unknown>): Promise<NativeRow> {
    return this.rows(authority, id, access, 'data.write', async (tx, table, target) => {
      const values = this.values(input, table.definition.columns);
      const clause = values.length ? `(${values.map(item => identifier(item.column.name)).join(',')}) VALUES (${values.map((item, index) => `$${index + 1}${['json', 'jsonb'].includes(item.column.type) ? '::text' : ''}::${pgTypes[item.column.type]}`).join(',')})` : 'DEFAULT VALUES';
      const rows = await tx.unsafe(`INSERT INTO ${target} ${clause} RETURNING ${selected(table.definition.columns)}`, values.map(item => item.value));
      return rowResult(rows[0], table.definition.columns);
    });
  }
  async update(authority: NativeDataAuthority, id: string, access: NativeRowAccess, rowId: string, revision: string, input: Record<string, unknown>): Promise<NativeRow> {
    parseComponent('Id', rowId); parseComponent('Revision', revision);
    return this.rows(authority, id, access, 'data.write', async (tx, table, target) => {
      const values = this.values(input, table.definition.columns);
      if (!values.length) throw new PlatformFault('validation', 'An update requires values');
      const set = values.map((item, index) => `${identifier(item.column.name)} = $${index + 3}${['json', 'jsonb'].includes(item.column.type) ? '::text' : ''}::${pgTypes[item.column.type]}`).join(',');
      const rows = await tx.unsafe(`UPDATE ${target} SET ${set}, _carbon_revision = _carbon_revision + 1 WHERE _carbon_id = $1::uuid AND _carbon_revision = $2::bigint RETURNING ${selected(table.definition.columns)}`, [rowId, revision, ...values.map(item => item.value)]);
      if (!rows.length) throw new PlatformFault('conflict', 'Row is unavailable or its revision changed');
      return rowResult(rows[0], table.definition.columns);
    });
  }
  async delete(authority: NativeDataAuthority, id: string, access: NativeRowAccess, rowId: string, revision: string): Promise<void> {
    parseComponent('Id', rowId); parseComponent('Revision', revision);
    await this.rows(authority, id, access, 'data.write', async (tx, _table, target) => {
      const rows = await tx.unsafe(`DELETE FROM ${target} WHERE _carbon_id = $1::uuid AND _carbon_revision = $2::bigint RETURNING _carbon_id`, [rowId, revision]);
      if (!rows.length) throw new PlatformFault('conflict', 'Row is unavailable or its revision changed');
    });
  }
}
