import { afterEach, describe, expect, test } from 'bun:test';
import { PostgresNativeTables, type NativeDataAuthority, type NativeDefinition } from '@carbon/data';
import { PostgresServiceLifecycleRepository, PostgresDatabaseEnvironmentDriver, databaseEnvironmentIdentifiers } from '@carbon/catalog';
import { migrate } from '../infrastructure/persistence/Database.ts';
import type { Principal } from '@carbon/contracts/platform';
import type { DataQuery, DataRowBoundary } from '@carbon/contracts/platform';
import type { DataSchemaChange } from '@carbon/contracts/platform';
import type { DataConstraint } from '@carbon/contracts/platform';
import type { DataImportExecution } from '@carbon/contracts/platform';
const testUrl = process.env.CARBON_SERVICE_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) { await cleanups.at(-1)!(); cleanups.pop(); } }, 30000);
async function rejected(work: Promise<unknown>): Promise<any> { try { await work; } catch (error) { return error; } throw new Error('Expected rejection'); }
const uuid = () => crypto.randomUUID();
const principal: Principal = { id: uuid(), kind: 'account', audience: 'dashboard', credentialId: uuid(), permissionRevision: '1' };
async function harness() {
  const url = new URL(testUrl!); if (url.pathname !== '/carbon_service_test') throw new Error('Requires dedicated test database');
  const admin = new Bun.SQL(url.href, { max: 1 }); const name = `carbon_service_test_${uuid().replaceAll('-', '')}_native`;
  await admin.unsafe(`CREATE DATABASE "${name}"`); url.pathname = '/' + name;
  const sql = new Bun.SQL(url.href, { max: 1 }); const roles: string[] = [];
  cleanups.push(async () => {
    await sql.close(); if (!/^carbon_service_test_[a-f0-9]{32}_native$/.test(name)) throw new Error('Unsafe cleanup');
    await admin.unsafe(`DROP DATABASE "${name}"`);
    for (const role of roles) { if (!/^ce_[a-f0-9]{32}$/.test(role)) throw new Error('Unsafe role cleanup'); await admin.unsafe(`DROP ROLE "${role}"`); }
    await admin.close();
  });
  await migrate(sql);
  const driver = new PostgresDatabaseEnvironmentDriver(); const lifecycle = new PostgresServiceLifecycleRepository(sql, driver);
  const environments: NativeDataAuthority[] = [];
  for (let i = 0; i < 2; i++) {
    const scope = { orgId: uuid(), projectId: uuid(), environmentId: uuid() }; const bindingId = uuid();
    await lifecycle.execute({ scope, bindingId, operationId: uuid(), stepId: uuid(), leaseId: uuid(), action: 'ensure', remoteResourceId: null }, principal, uuid(), async () => true);
    roles.push(databaseEnvironmentIdentifiers(scope.environmentId).role);
    environments.push({ scope, bindingId, principal, requestId: uuid(), permit: async () => true });
  }
  return { sql, url: url.href, data: new PostgresNativeTables(sql), environments, driver };
}
function definition(): NativeDefinition {
  return { name: 'notes', columns: [
    { name: 'owner', type: 'uuid', nullable: false },
    { name: 'body', type: 'text', nullable: false, default: { kind: 'literal', value: "O'Reilly \\ default" } },
    { name: 'amount', type: 'decimal', nullable: false, default: { kind: 'literal', value: '9007199254740993.123456789' } },
    { name: 'sequence', type: 'integer', nullable: false, default: { kind: 'literal', value: '9007199254740993' } },
    { name: 'payload', type: 'jsonb', nullable: false, default: { kind: 'literal', value: { safe: true } } },
    { name: 'numbers', type: 'integer[]', nullable: false, default: { kind: 'literal', value: ['9007199254740993'] } },
  ], policies: { enabled: true, rules: [{ id: uuid(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } };
}
function app(authority: NativeDataAuthority, id: string): NativeDataAuthority { return { ...authority, principal: { ...authority.principal, id, kind: 'app_user', audience: 'app' }, requestId: uuid() }; }
const access = { mode: 'application' } as const;

suite('canonical native PostgreSQL policies', () => {
  test('native imports preserve exact rows, reconcile receipts and apply explicit key conflict behavior', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid(); const actor = app(authority, user);
    await h.data.create(authority, id, { ...definition(), primaryKey: 'body', constraints: [{ id: uuid(), name: 'positive', kind: 'check', columns: ['amount'], check: { column: 'amount', operator: 'gte', value: '0' } }] });
    const command: DataImportExecution = { kind: 'rows.import.apply', commandId: uuid(), tableId: id, revision: '1', access: { mode: 'policy-preview', userId: user },
      input: { format: 'json', text: JSON.stringify([{ actor: user, title: 'first', amount: '9007199254740993.123456789', numbers: ['9223372036854775807'] }, { actor: user, title: 'second' }]), mapping: { actor: 'owner', title: 'body' }, conflict: 'error', atomic: true } };
    const peer = new Bun.SQL(h.url, { max: 1 }); cleanups.push(async () => { await peer.close(); });
    const [first, duplicate] = await Promise.all([h.data.applyImport(authority, command), new PostgresNativeTables(peer).applyImport(authority, command)]);
    expect(first).toMatchObject({ total: 2, inserted: 2, updated: 0, skipped: 0, failed: 0, errors: [] }); expect(duplicate).toEqual(first);
    expect(await new PostgresNativeTables(h.sql).applyImport(authority, { ...command, input: { ...command.input, mapping: { title: 'body', actor: 'owner' } } })).toEqual(first);
    expect((await rejected(h.data.applyImport(authority, { ...command, input: { ...command.input, text: '[]' } }))).code).toBe('conflict');
    const before = await h.data.query(actor, id, access); expect(before).toHaveLength(2);
    const existing = before.find(row => row.values.body === 'first')!; expect(existing.values.amount).toBe('9007199254740993.123456789'); expect(existing.values.numbers).toEqual(['9223372036854775807']);
    const update: DataImportExecution = { ...command, commandId: uuid(), input: { ...command.input, text: JSON.stringify([{ actor: user, title: 'first', amount: '1' }, { actor: user, title: 'third' }]), conflict: 'update' } };
    expect((await rejected(h.data.applyImport(authority, update))).code).toBe('validation');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${update.commandId}`).toHaveLength(0);
    expect(await h.data.applyImport(authority, { ...update, confirmation: 'notes' })).toMatchObject({ inserted: 1, updated: 1, skipped: 0, failed: 0 });
    const after = await h.data.query(actor, id, access); const changed = after.find(row => row.values.body === 'first')!;
    expect(changed.id).toBe(existing.id); expect(changed.revision).toBe('2'); expect(changed.values.amount).toBe('1'); expect(changed.values.numbers).toEqual(existing.values.numbers);
    const skip: DataImportExecution = { ...update, commandId: uuid(), input: { ...update.input, conflict: 'skip', text: JSON.stringify([{ actor: user, title: 'first' }, { actor: user, title: 'fourth' }]) } };
    expect(await h.data.applyImport(authority, skip)).toMatchObject({ inserted: 1, updated: 0, skipped: 1, failed: 0 });
    const invalid: DataImportExecution = { ...command, commandId: uuid(), input: { ...command.input, text: JSON.stringify([{ actor: user, title: 'rolled-back' }, { actor: user, title: 'bad', amount: '-1' }]) } };
    const error = await rejected(h.data.applyImport(authority, invalid)); expect(error.code).toBe('conflict'); expect(error.fieldErrors).toEqual({ row: '2', reason: 'constraint_violation' });
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${invalid.commandId}`).toHaveLength(0);
    expect((await h.data.query(actor, id, access)).some(row => row.values.body === 'rolled-back')).toBe(false);
    expect((await rejected(h.data.applyImport(authority, { ...command, commandId: uuid(), revision: '99' }))).code).toBe('conflict');
    expect((await rejected(h.data.applyImport(h.environments[1]!, { ...command, commandId: uuid() }))).code).toBe('not_found');
    expect((await rejected(h.data.applyImport(actor, command))).code).toBe('forbidden');
    expect((await h.sql`SELECT count(*)::int AS count FROM canonical_data_events WHERE table_id = ${id} AND action = 'rows.import'`)[0].count).toBe(3);
  }, 15000);

  test('partial native imports isolate row failures but revoke or unexpected failure rolls back every effect', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid(); const other = uuid(); const actor = app(authority, user);
    await h.data.create(authority, id, { ...definition(), primaryKey: 'body', constraints: [{ id: uuid(), name: 'positive', kind: 'check', columns: ['amount'], check: { column: 'amount', operator: 'gte', value: '0' } }] });
    await h.data.insert(actor, id, access, { owner: user, body: 'existing' });
    await h.data.insert(app(authority, other), id, access, { owner: other, body: 'hidden' });
    const command: DataImportExecution = { kind: 'rows.import.apply', commandId: uuid(), tableId: id, revision: '1', access: { mode: 'policy-preview', userId: user },
      input: { format: 'json', mapping: {}, conflict: 'error', atomic: false, text: JSON.stringify([
        { owner: user, body: 'valid-one' }, { owner: user, body: 'existing' }, { owner: user, body: 'bad-type', amount: 1 },
        { owner: other, body: 'private denied value' }, { owner: user, body: 'bad-check', amount: '-1' }, { owner: user, body: 'valid-two' },
      ]) } };
    const result = await h.data.applyImport(authority, command);
    expect(result).toMatchObject({ total: 6, inserted: 2, updated: 0, skipped: 0, failed: 4, errorsTruncated: false });
    expect(result.errors.map(error => [error.row, error.code])).toEqual([[2, 'constraint_violation'], [3, 'invalid_value'], [4, 'policy_denied'], [5, 'constraint_violation']]);
    expect(JSON.stringify(result.errors)).not.toContain('private denied value'); expect(await h.data.applyImport(authority, command)).toEqual(result);
    const hidden: DataImportExecution = { ...command, commandId: uuid(), confirmation: 'notes', input: { ...command.input, atomic: true, conflict: 'update', text: JSON.stringify([{ owner: user, body: 'hidden' }]) } };
    expect((await rejected(h.data.applyImport(authority, hidden))).code).toBe('forbidden');
    expect((await h.data.query(app(authority, other), id, access))[0]!.values.body).toBe('hidden');
    const revoked: DataImportExecution = { ...command, commandId: uuid(), input: { ...command.input, text: JSON.stringify([{ owner: user, body: 'revoked-write' }]) } };
    let checks = 0;
    expect((await rejected(h.data.applyImport({ ...authority, permit: async () => ++checks < 3 }, revoked))).code).toBe('forbidden');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${revoked.commandId}`).toHaveLength(0);
    expect((await h.data.query(actor, id, access)).some(row => row.values.body === 'revoked-write')).toBe(false);
    expect(await h.data.applyImport(authority, revoked)).toMatchObject({ inserted: 1, failed: 0 });
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const target = `"${names.schema}"."ct_${id.replaceAll('-', '')}"`;
    await h.sql.unsafe(`CREATE FUNCTION "${names.schema}".fail_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body = 'unexpected' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`);
    await h.sql.unsafe(`CREATE TRIGGER fail_import BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION "${names.schema}".fail_import()`);
    const unexpected: DataImportExecution = { ...command, commandId: uuid(), input: { ...command.input, text: JSON.stringify([{ owner: user, body: 'also-rolled-back' }, { owner: user, body: 'unexpected' }]) } };
    expect((await rejected(h.data.applyImport(authority, unexpected))).errno).toBe('P0001');
    expect((await h.data.query(actor, id, access)).some(row => row.values.body === 'also-rolled-back')).toBe(false);
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${unexpected.commandId}`).toHaveLength(0);
    const oldCommand = { kind: 'row.insert' as const, commandId: command.commandId, tableId: id, revision: '1', access: command.access, values: { owner: user } };
    expect((await rejected(h.data.command(authority, oldCommand))).code).toBe('conflict');
  }, 15000);

  test('native import batches enforce duplicate conflict modes and retain bounded error evidence', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid();
    await h.data.create(authority, id, { ...definition(), primaryKey: 'body' });
    const command: DataImportExecution = { kind: 'rows.import.apply', commandId: uuid(), tableId: id, revision: '1', access: { mode: 'policy-preview', userId: user },
      input: { format: 'json', text: '[]', mapping: {}, conflict: 'error', atomic: true } };
    for (const conflict of ['error', 'skip', 'update'] as const) {
      const duplicate = { ...command, commandId: uuid(), confirmation: 'notes', input: { ...command.input, conflict,
        text: JSON.stringify([{ owner: user, body: 'batch-' + conflict, amount: '1' }, { owner: user, body: 'batch-' + conflict, amount: '2' }]) } };
      if (conflict === 'error') expect((await rejected(h.data.applyImport(authority, duplicate))).code).toBe('conflict');
      else expect(await h.data.applyImport(authority, duplicate)).toMatchObject({ total: 2, inserted: 1, updated: conflict === 'update' ? 1 : 0, skipped: conflict === 'skip' ? 1 : 0, failed: 0 });
    }
    const rows = await h.data.query(app(authority, user), id, access);
    expect(rows.map(row => row.values.body).sort()).toEqual(['batch-skip', 'batch-update']);
    expect(rows.find(row => row.values.body === 'batch-update')!.values.amount).toBe('2');
    const other = uuid(); const partial = { ...command, commandId: uuid(), input: { ...command.input, atomic: false,
      text: JSON.stringify([...Array.from({ length: 125 }, (_, i) => ({ owner: other, body: 'denied-' + i })), { owner: user, body: 'valid-last' }]) } };
    const result = await h.data.applyImport(authority, partial);
    expect(result).toMatchObject({ total: 126, inserted: 1, failed: 125, errorsTruncated: true }); expect(result.errors).toHaveLength(100);
    expect(result.errors[0]).toMatchObject({ row: 1, code: 'policy_denied' }); expect(result.errors[99]).toMatchObject({ row: 100, code: 'policy_denied' });
    const maximum = { ...command, commandId: uuid(), input: { ...command.input, text: JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ owner: user, body: 'maximum-' + i }))) } };
    expect(await h.data.applyImport(authority, maximum)).toMatchObject({ total: 1000, inserted: 1000, updated: 0, skipped: 0, failed: 0 });
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
    const count = await h.sql.unsafe(`SELECT count(*)::int AS count FROM "${names.schema}"."ct_${id.replaceAll('-', '')}"`);
    expect(count[0].count).toBe(1003);
  }, 20000);
  test('managed constraints and indexes validate data, follow renames and reject drift or dependency loss atomically', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid(); const actor = app(authority, user);
    const unique: DataConstraint = { id: uuid(), name: 'owner_body', kind: 'unique', columns: ['owner', 'body'] };
    const check: DataConstraint = { id: uuid(), name: 'positive_amount', kind: 'check', columns: ['amount'], check: { column: 'amount', operator: 'gte', value: '0' } };
    const index: DataConstraint = { id: uuid(), name: 'body_index', kind: 'index', columns: ['body'] };
    const forbidden = "'; DROP TABLE accounts; --";
    const guard: DataConstraint = { id: uuid(), name: 'literal_guard', kind: 'check', columns: ['body'], check: { column: 'body', operator: 'ne', value: forbidden } };
    await h.data.create(authority, id, { ...definition(), constraints: [unique, check, index, guard] });
    expect(await h.sql`SELECT constraint_id FROM canonical_data_constraints WHERE table_id = ${id}`).toHaveLength(4);
    const first = await h.data.insert(actor, id, access, { owner: user });
    expect((await rejected(h.data.insert(actor, id, access, { owner: user }))).errno).toBe('23505');
    expect((await rejected(h.data.insert(actor, id, access, { owner: user, body: forbidden }))).errno).toBe('23514');
    const second = await h.data.insert(actor, id, access, { owner: user, body: 'second', amount: '0' });
    const change = (revision: string, change: DataSchemaChange, confirmation?: string, commandId = uuid()) => h.data.command(authority, { kind: 'table.alter', commandId, tableId: id, revision, change, confirmation });
    const stronger: DataConstraint = { ...check, check: { ...check.check, value: '1' } };
    const failedId = uuid(); expect((await rejected(change('1', { kind: 'constraint.set', constraint: stronger }, 'notes', failedId))).errno).toBe('23514');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${failedId}`).toHaveLength(0);
    expect((await h.data.get(authority, id)).revision).toBe('1');
    await h.data.update(actor, id, access, second.id, second.revision, { amount: '2' });
    expect((await change('1', { kind: 'constraint.set', constraint: stronger }, 'notes', failedId)).revision).toBe('2');
    expect((await change('2', { kind: 'column.edit', original: 'body', column: { name: 'content', type: 'text', nullable: false } })).revision).toBe('3');
    const current = await h.data.get(authority, id);
    expect(current.definition.constraints!.find(item => item.id === guard.id)).toMatchObject({ columns: ['content'], check: { column: 'content' } });
    expect((await h.data.query(actor, id, access)).find(row => row.id === first.id)!.values.content).toBe(first.values.body);
    expect((await rejected(change('3', { kind: 'column.drop', name: 'content' }, 'notes'))).code).toBe('conflict');
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const target = `"${names.schema}"."ct_${id.replaceAll('-', '')}"`;
    await h.sql.unsafe(`CREATE TABLE "${names.schema}".constraint_child (owner uuid, content text, FOREIGN KEY(owner, content) REFERENCES ${target} (owner, content))`);
    const relabeled = { ...current.definition.constraints!.find(item => item.id === unique.id)!, name: 'renamed_unique' };
    expect((await change('3', { kind: 'constraint.set', constraint: relabeled })).revision).toBe('4');
    expect((await rejected(change('4', { kind: 'constraint.delete', constraintId: unique.id }, 'notes'))).errno).toBe('2BP01');
    await h.sql.unsafe(`DROP TABLE "${names.schema}".constraint_child`);
    expect((await change('4', { kind: 'constraint.delete', constraintId: unique.id }, 'notes')).revision).toBe('5');
    expect((await change('5', { kind: 'constraint.delete', constraintId: index.id })).revision).toBe('6');
    expect((await change('6', { kind: 'constraint.delete', constraintId: guard.id }, 'notes')).revision).toBe('7');
    expect((await change('7', { kind: 'column.drop', name: 'content' }, 'notes')).revision).toBe('8');
    let checks = 0; const revokedId = uuid();
    expect((await rejected(h.data.command({ ...authority, permit: async () => ++checks < 3 }, { kind: 'table.alter', tableId: id, revision: '8', commandId: revokedId, change: { kind: 'constraint.delete', constraintId: check.id }, confirmation: 'notes' }))).code).toBe('forbidden');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${revokedId}`).toHaveLength(0);
    expect((await rejected(h.data.insert(actor, id, access, { owner: user, amount: '0' }))).errno).toBe('23514');
    const native = (await h.sql`SELECT conname FROM pg_constraint WHERE conrelid = ${target}::regclass AND contype = 'c' AND conname LIKE 'cc_%'`)[0].conname;
    if (!/^cc_[a-f0-9]{48}$/.test(native)) throw new Error('Unexpected fixture constraint');
    await h.sql.unsafe(`ALTER TABLE ${target} DROP CONSTRAINT "${native}"`);
    await h.sql.unsafe(`ALTER TABLE ${target} ADD CONSTRAINT "${native}" CHECK (amount >= 0)`);
    expect((await rejected(change('8', { kind: 'rename', name: 'drifted' }))).code).toBe('conflict');
  });
  test('foreign keys point at a primary key in the same environment, refuse orphans and referenced deletions, and block key changes with a cross-table impact preview', async () => {
    const h = await harness(); const authority = h.environments[0]!; const elsewhere = h.environments[1]!; const user = uuid(); const actor = app(authority, user);
    const fault = (error: { code?: string; errno?: string; name?: string }): string => error.name === 'ContractError' ? 'validation' : error.errno ?? error.code ?? String(error);
    const policies = () => ({ enabled: true, rules: [{ id: uuid(), name: 'Owner', kind: 'owner' as const, ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] as ('select' | 'insert' | 'update' | 'delete')[] }] });
    const ownerColumn = { name: 'owner', type: 'uuid' as const, nullable: false };
    const customers = uuid(); const orders = uuid(); const keyless = uuid();
    const customerDefinition = (): NativeDefinition => ({ name: 'customers', columns: [ownerColumn, { name: 'code', type: 'text', nullable: false }, { name: 'label', type: 'text', nullable: true }], primaryKey: 'code', policies: policies() });
    const link: DataConstraint = { id: uuid(), name: 'order_customer', kind: 'foreign-key', columns: ['customer'], references: { tableId: customers } };
    const orderDefinition = (constraint: DataConstraint = link, type: 'text' | 'uuid' = 'text'): NativeDefinition => ({ name: 'orders',
      columns: [ownerColumn, { name: 'customer', type, nullable: true }, { name: 'total', type: 'integer', nullable: false }], policies: policies(), constraints: [constraint] });
    const alter = (tableId: string, revision: string, change: DataSchemaChange, confirmation?: string) => h.data.command({ ...authority, requestId: uuid() }, { kind: 'table.alter', tableId, revision, commandId: uuid(), change, ...(confirmation ? { confirmation } : {}) });
    const tables = async () => (await h.sql`SELECT name FROM canonical_data_tables ORDER BY name`).map((row: { name: string }) => row.name);

    // What a foreign key may point at.
    expect(fault(await rejected(h.data.create(authority, orders, orderDefinition())))).toBe('not_found');
    await h.data.create(authority, customers, customerDefinition());
    await h.data.create(authority, keyless, { name: 'keyless', columns: [ownerColumn, { name: 'code', type: 'text', nullable: false }], policies: policies() });
    expect(fault(await rejected(h.data.create(authority, orders, orderDefinition(link, 'uuid'))))).toBe('validation');
    expect(fault(await rejected(h.data.create(authority, orders, orderDefinition({ ...link, references: { tableId: keyless } }))))).toBe('validation');
    // Another environment's table does not exist as far as this one can tell.
    expect(fault(await rejected(h.data.create(elsewhere, uuid(), orderDefinition())))).toBe('not_found');
    expect(fault(await rejected(h.data.create(authority, orders, { ...orderDefinition(), constraints: [{ ...link, columns: ['customer', 'total'] } as unknown as DataConstraint] })))).toBe('validation');
    expect(await tables()).toEqual(['customers', 'keyless']);
    await h.data.create(authority, orders, orderDefinition());
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const physical = (id: string) => `"${names.schema}"."ct_${id.replaceAll('-', '')}"`;
    const native = async (id: string) => (await h.sql`SELECT confdeltype::text AS on_delete, confupdtype::text AS on_update, convalidated FROM pg_constraint WHERE conrelid = ${physical(id)}::regclass AND contype = 'f'`) as unknown[];
    // Real native constraint, with no cascading.
    expect(await native(orders)).toEqual([{ on_delete: 'r', on_update: 'r', convalidated: true }]);

    // Rows: an order needs an existing customer or none; a referenced customer cannot be deleted.
    const acme = await h.data.insert(actor, customers, access, { owner: user, code: 'acme', label: 'Acme' });
    const order = await h.data.insert(actor, orders, access, { owner: user, customer: 'acme', total: '10' });
    await h.data.insert(actor, orders, access, { owner: user, customer: null, total: '5' });
    expect(fault(await rejected(h.data.insert(actor, orders, access, { owner: user, customer: 'ghost', total: '1' })))).toBe('23503');
    expect(fault(await rejected(h.data.update(actor, orders, access, order.id, order.revision, { customer: 'ghost' })))).toBe('23503');
    expect(fault(await rejected(h.data.delete(actor, customers, access, acme.id, acme.revision)))).toBe('23503');
    expect(fault(await rejected(h.data.update(actor, customers, access, acme.id, acme.revision, { code: 'acme2' })))).toBe('23503');
    expect(await h.data.query(actor, orders, access)).toHaveLength(2); expect(await h.data.query(actor, customers, access)).toHaveLength(1);

    // Impact preview across tables: changing the referenced key names the tables that depend on it and is marked blocked.
    const inbound = `inbound-foreign-key:${orders}:${link.id}`;
    const renameKey: DataSchemaChange = { kind: 'column.edit', original: 'code', column: { name: 'identifier', type: 'text', nullable: false } };
    const retypeKey: DataSchemaChange = { kind: 'column.edit', original: 'code', column: { name: 'code', type: 'uuid', nullable: false } };
    expect(await h.data.preview(authority, customers, renameKey)).toMatchObject({ blocked: true, dependencies: ['primary-key', inbound] });
    expect(await h.data.preview(authority, customers, { kind: 'primary-key', column: null })).toMatchObject({ blocked: true, destructive: true, dependencies: ['primary-key:code', inbound] });
    expect(await h.data.preview(authority, customers, { kind: 'column.edit', original: 'label', column: { name: 'title', type: 'text', nullable: true } })).toMatchObject({ blocked: false, dependencies: [] });
    expect(await h.data.preview(authority, customers, { kind: 'column.edit', original: 'code', column: { name: 'code', type: 'text', nullable: false, default: { kind: 'literal', value: 'x' } } })).toMatchObject({ blocked: false });
    expect(await h.data.preview(authority, orders, { kind: 'constraint.set', constraint: { ...link, name: 'renamed_link' } })).toMatchObject({ blocked: false, destructive: false });
    // A preview of a foreign key that could not be created fails the same way the change would.
    expect(fault(await rejected(h.data.preview(authority, orders, { kind: 'constraint.set', constraint: { ...link, id: uuid(), name: 'bad', references: { tableId: keyless } } })))).toBe('validation');
    expect(fault(await rejected(h.data.preview(authority, orders, { kind: 'constraint.set', constraint: { ...link, id: uuid(), name: 'bad', references: { tableId: uuid() } } })))).toBe('not_found');
    for (const change of [renameKey, retypeKey, { kind: 'primary-key', column: null }, { kind: 'primary-key', column: 'label' }] as DataSchemaChange[]) expect(fault(await rejected(alter(customers, '1', change, 'customers')))).toBe('conflict');
    expect((await h.data.get(authority, customers)).revision).toBe('1');
    // Changes that leave the key alone go through, and a table rename does not disturb the link.
    expect((await alter(customers, '1', { kind: 'column.edit', original: 'label', column: { name: 'title', type: 'text', nullable: true } })).revision).toBe('2');
    expect((await alter(customers, '2', { kind: 'rename', name: 'clients' })).revision).toBe('3');

    // The referencing column can be renamed; the link follows it and is still enforced. Its type cannot drift from the key's.
    expect((await alter(orders, '1', { kind: 'column.edit', original: 'customer', column: { name: 'buyer', type: 'text', nullable: true } })).revision).toBe('2');
    expect((await h.data.get(authority, orders)).definition.constraints).toEqual([{ ...link, columns: ['buyer'] }]);
    expect(fault(await rejected(h.data.insert(actor, orders, access, { owner: user, buyer: 'ghost', total: '1' })))).toBe('23503');
    expect(['42804', 'validation', '0A000']).toContain(fault(await rejected(alter(orders, '2', { kind: 'column.edit', original: 'buyer', column: { name: 'buyer', type: 'uuid', nullable: true } }, 'orders'))));
    expect((await h.data.get(authority, orders)).revision).toBe('2'); expect(await native(orders)).toHaveLength(1);

    // Adding a link to a table whose rows already break it changes nothing.
    const invoices = uuid(); const late: DataConstraint = { id: uuid(), name: 'invoice_customer', kind: 'foreign-key', columns: ['customer'], references: { tableId: customers } };
    await h.data.create(authority, invoices, { name: 'invoices', columns: [ownerColumn, { name: 'customer', type: 'text', nullable: false }], policies: policies() });
    const stray = await h.data.insert(actor, invoices, access, { owner: user, customer: 'nobody' });
    expect(fault(await rejected(alter(invoices, '1', { kind: 'constraint.set', constraint: late })))).toBe('23503');
    expect((await h.data.get(authority, invoices)).revision).toBe('1'); expect(await native(invoices)).toEqual([]); expect(await h.sql`SELECT 1 FROM canonical_data_constraints WHERE table_id = ${invoices}`).toHaveLength(0);
    await h.data.delete(actor, invoices, access, stray.id, stray.revision);
    expect((await alter(invoices, '1', { kind: 'constraint.set', constraint: late })).revision).toBe('2');
    expect((await h.data.preview(authority, customers, renameKey)).dependencies).toEqual(['primary-key', `inbound-foreign-key:${invoices}:${late.id}`, inbound].sort((a, b) => a === 'primary-key' ? -1 : b === 'primary-key' ? 1 : a.split(':')[1]!.localeCompare(b.split(':')[1]!)));

    // Once nothing references the key, it can change.
    expect(fault(await rejected(alter(orders, '2', { kind: 'constraint.delete', constraintId: link.id })))).toBe('validation');
    expect((await alter(orders, '2', { kind: 'constraint.delete', constraintId: link.id }, 'orders')).revision).toBe('3');
    expect(fault(await rejected(alter(customers, '3', renameKey, 'clients')))).toBe('conflict');
    expect((await alter(invoices, '2', { kind: 'constraint.delete', constraintId: late.id }, 'invoices')).revision).toBe('3');
    expect(await h.data.preview(authority, customers, renameKey)).toMatchObject({ blocked: false, dependencies: ['primary-key'] });
    expect((await alter(customers, '3', renameKey, 'clients')).revision).toBe('4');
    expect(await native(orders)).toEqual([]); await h.data.insert(actor, orders, access, { owner: user, buyer: 'ghost', total: '1' });

    // A table can reference itself.
    const categories = uuid(); const parent: DataConstraint = { id: uuid(), name: 'category_parent', kind: 'foreign-key', columns: ['parent'], references: { tableId: categories } };
    await h.data.create(authority, categories, { name: 'categories', columns: [ownerColumn, { name: 'slug', type: 'text', nullable: false }, { name: 'parent', type: 'text', nullable: true }], primaryKey: 'slug', policies: policies(), constraints: [parent] });
    const root = await h.data.insert(actor, categories, access, { owner: user, slug: 'root', parent: null }); await h.data.insert(actor, categories, access, { owner: user, slug: 'leaf', parent: 'root' });
    expect(fault(await rejected(h.data.insert(actor, categories, access, { owner: user, slug: 'lost', parent: 'nowhere' })))).toBe('23503');
    expect(fault(await rejected(h.data.delete(actor, categories, access, root.id, root.revision)))).toBe('23503');
    expect(await h.data.preview(authority, categories, { kind: 'primary-key', column: null })).toMatchObject({ blocked: true, dependencies: ['primary-key:slug', `inbound-foreign-key:${categories}:${parent.id}`] });
    expect(fault(await rejected(alter(categories, '1', { kind: 'primary-key', column: null }, 'categories')))).toBe('conflict');

    // A link changed behind the catalog's back is noticed before the next schema change.
    const nativeName = (await h.sql`SELECT conname FROM pg_constraint WHERE conrelid = ${physical(categories)}::regclass AND contype = 'f'`)[0].conname;
    await h.sql.unsafe(`ALTER TABLE ${physical(categories)} DROP CONSTRAINT "${nativeName}"`);
    expect(fault(await rejected(alter(categories, '1', { kind: 'column.add', column: { name: 'note', type: 'text', nullable: true } })))).toBe('conflict');
    await h.sql.unsafe(`ALTER TABLE ${physical(categories)} ADD CONSTRAINT "${nativeName}" FOREIGN KEY (parent) REFERENCES ${physical(categories)} (slug) ON DELETE CASCADE`);
    expect(fault(await rejected(alter(categories, '1', { kind: 'column.add', column: { name: 'note', type: 'text', nullable: true } })))).toBe('conflict');
    expect((await h.data.get(authority, categories)).revision).toBe('1');
  });

  test('the change feed captures every row change in its own transaction, in commit order, and tells each reader only about rows they could see', async () => {
    const h = await harness(); const authority = h.environments[0]!; const elsewhere = h.environments[1]!; const alice = uuid(); const bob = uuid(); const id = uuid();
    const fault = (error: { code?: string; errno?: string; name?: string }): string => error.name === 'ContractError' ? 'validation' : error.errno ?? error.code ?? String(error);
    const ownerRule = { id: uuid(), name: 'Owner', kind: 'owner' as const, ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] as ('select' | 'insert' | 'update' | 'delete')[] };
    const columns = [{ name: 'owner', type: 'uuid' as const, nullable: false }, { name: 'body', type: 'text' as const, nullable: false }];
    await h.data.create(authority, id, { name: 'notes', columns, policies: { enabled: true, rules: [ownerRule] } });
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const target = `"${names.schema}"."ct_${id.replaceAll('-', '')}"`;
    const as = (user: string) => app(authority, user);
    // One reader's view of the feed: what they are told, as [operation, row, revision].
    const feed = async (reader: NativeDataAuthority, cursor?: string, limit?: number, tableId = id, mode: { mode: 'application' } | { mode: 'policy-preview'; userId?: string } = access) => {
      const result = await h.data.changes({ ...reader, requestId: uuid() }, { kind: 'rows.changes', tableId, access: mode, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) });
      return { ...result, seen: result.events.map(event => [event.operation, event.rowId, event.revision]) };
    };
    // A reader starts from now: no history, and a cursor to continue from.
    const start = await feed(as(alice)); expect(start).toMatchObject({ tableId: id, events: [], reset: false }); expect(start.nextCursor).toBe('1.0.0');

    const one = await h.data.insert(as(alice), id, access, { owner: alice, body: 'first' });
    const two = await h.data.insert(as(bob), id, access, { owner: bob, body: 'bob only' });
    const edited = await h.data.update(as(alice), id, access, one.id, one.revision, { body: 'first, edited' });
    await h.data.delete(as(alice), id, access, one.id, edited.revision);
    // Alice is told about her row's whole life, in order, and nothing about Bob's.
    const hers = await feed(as(alice), start.nextCursor); expect(hers.seen).toEqual([['insert', one.id, '1'], ['update', one.id, '2'], ['delete', one.id, null]]); expect(hers.reset).toBe(false);
    expect((await feed(as(bob), start.nextCursor)).seen).toEqual([['insert', two.id, '1']]);
    // Cursors are strictly increasing positions, and each event carries the cursor that continues after it.
    expect(new Set(hers.events.map(event => event.cursor)).size).toBe(3); expect(hers.nextCursor).toBe(hers.events.at(-1)!.cursor);
    expect((await feed(as(alice), hers.events[0]!.cursor)).seen).toEqual([['update', one.id, '2'], ['delete', one.id, null]]);
    expect((await feed(as(alice), hers.nextCursor)).seen).toEqual([]); expect((await feed(as(alice), hers.nextCursor)).nextCursor).toBe(hers.nextCursor);
    // The cursor moves past changes the reader cannot see, so they are not scanned again and nothing about them leaks.
    const bobs = await feed(as(bob), start.nextCursor); expect(bobs.nextCursor).toBe(hers.nextCursor);
    // Pages: a limit stops the page, and the next one continues exactly after it.
    const page = await feed(as(alice), start.nextCursor, 2); expect(page.seen).toHaveLength(2); expect((await feed(as(alice), page.nextCursor, 2)).seen).toEqual([['delete', one.id, null]]);
    // An account previewing as a user sees what that user would; previewing as nobody sees nothing here.
    expect((await feed(authority, start.nextCursor, undefined, id, { mode: 'policy-preview', userId: bob })).seen).toEqual([['insert', two.id, '1']]);
    expect((await feed(authority, start.nextCursor, undefined, id, { mode: 'policy-preview' })).seen).toEqual([]);
    expect(fault(await rejected(feed(authority, start.nextCursor)))).toBe('forbidden'); expect(fault(await rejected(feed(as(alice), start.nextCursor, undefined, id, { mode: 'policy-preview', userId: bob })))).toBe('forbidden');
    for (const cursor of ['1', '1.2', 'x.1.1', '0.1.1', '1.-1.1', '1.1.1.1']) expect(fault(await rejected(feed(as(alice), cursor)))).toBe('validation');
    // Another environment has no such table, and a reader whose authority is gone gets nothing.
    expect(fault(await rejected(feed(app(elsewhere, alice), start.nextCursor)))).toBe('not_found');
    expect(fault(await rejected(feed({ ...as(alice), permit: async () => false }, start.nextCursor)))).toBe('forbidden');
    let checks = 0; expect(fault(await rejected(feed({ ...as(alice), permit: async () => ++checks < 2 }, start.nextCursor)))).toBe('forbidden');

    // Capture is in the database, not the API: a change made by plain SQL is in the feed, and a rolled-back one is not.
    let position = hers.nextCursor;
    await h.sql.unsafe(`INSERT INTO ${target} (owner, body) VALUES ($1::uuid, 'written by an operator')`, [alice]);
    await h.sql.begin(async tx => { await tx.unsafe(`INSERT INTO ${target} (owner, body) VALUES ($1::uuid, 'never committed')`, [alice]); throw new Error('rollback'); }).catch(() => undefined);
    const direct = await feed(as(alice), position); expect(direct.seen.map(event => event[0])).toEqual(['insert']); position = direct.nextCursor;
    expect(Number((await h.sql`SELECT count(*)::integer AS count FROM data_change_events WHERE table_id = ${id}`)[0].count)).toBe(5);
    // The role that changes rows can neither read the feed nor write to it.
    const forbidden = async (statement: string) => fault(await rejected(h.sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE "${names.role}"`); await tx.unsafe(statement); })));
    expect(await forbidden('SELECT 1 FROM public.data_change_events')).toBe('42501');
    expect(await forbidden(`INSERT INTO public.data_change_events (environment_id, table_id, row_id, operation, row_revision, visibility) VALUES ('${authority.scope.environmentId}', '${id}', '${uuid()}', 'insert', 1, '{"public":true,"owners":[]}')`)).toBe('42501');
    expect(await forbidden(`SELECT public.carbon_capture_change()`)).not.toBe('ok');

    // Commit order: a change that commits while an earlier transaction is still open is held back until that one ends,
    // so nothing can ever appear behind a cursor that was already handed out.
    const second = new Bun.SQL(h.url, { max: 1 }); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let opened!: () => void; const ready = new Promise<void>(resolve => { opened = resolve; });
    const slow = second.begin(async tx => { await tx.unsafe(`INSERT INTO ${target} (owner, body) VALUES ($1::uuid, 'slow transaction')`, [alice]); opened(); await gate; });
    await ready; const fast = await h.data.insert(as(alice), id, access, { owner: alice, body: 'fast transaction' });
    const held = await feed(as(alice), position); expect(held.seen).toEqual([]); expect(held.nextCursor).toBe(position);
    release(); await slow; await second.close();
    const both = await feed(as(alice), position); expect(both.seen.map(event => event[0])).toEqual(['insert', 'insert']); expect(both.seen[1]![1]).toBe(fast.id); position = both.nextCursor;

    // Ownership changes hands: the row leaves one reader's view and enters another's, and both are told.
    const moved = await h.sql.unsafe(`UPDATE ${target} SET owner = $1::uuid, _carbon_revision = _carbon_revision + 1 WHERE _carbon_id = $2::uuid RETURNING _carbon_revision::text AS revision`, [bob, fast.id]);
    expect((await feed(as(alice), position)).seen).toEqual([['update', fast.id, moved[0].revision]]); expect((await feed(as(bob), position)).seen).toEqual([['update', fast.id, moved[0].revision]]);
    const carol = uuid(); expect((await feed(as(carol), position)).seen).toEqual([]);

    // Policies decide who is told, and they are part of the table's revision: changing them resets every cursor.
    const open = await h.data.replacePolicies(authority, id, '1', { enabled: true, rules: [ownerRule, { id: uuid(), name: 'Everyone reads', kind: 'public-read', operations: ['select'] }] });
    const stale = await feed(as(carol), position); expect(stale).toMatchObject({ events: [], reset: true }); expect(stale.nextCursor.startsWith(`${open.revision}.`)).toBe(true);
    const published = await h.data.insert(as(alice), id, access, { owner: alice, body: 'now public' });
    expect((await feed(as(carol), stale.nextCursor)).seen).toEqual([['insert', published.id, '1']]);
    expect((await feed(authority, stale.nextCursor, undefined, id, { mode: 'policy-preview' })).seen).toEqual([['insert', published.id, '1']]);
    // With policies off nobody reads the table through the API, and nobody is told about its changes.
    const closed = await h.data.replacePolicies(authority, id, open.revision, { enabled: false, rules: [ownerRule] }); const quiet = await feed(as(alice), `${closed.revision}.0.0`);
    await h.sql.unsafe(`INSERT INTO ${target} (owner, body) VALUES ($1::uuid, 'unseen')`, [alice]);
    expect((await feed(as(alice), quiet.nextCursor)).seen).toEqual([]);
    const reopened = await h.data.replacePolicies(authority, id, closed.revision, { enabled: true, rules: [ownerRule] }); const fresh = (await feed(as(alice))).nextCursor; expect(fresh.startsWith(`${reopened.revision}.`)).toBe(true);
    // A schema change is a new revision too.
    await h.data.command({ ...authority, requestId: uuid() }, { kind: 'table.alter', tableId: id, revision: reopened.revision, commandId: uuid(), change: { kind: 'column.add', column: { name: 'note', type: 'text', nullable: true } } });
    expect(await feed(as(alice), fresh)).toMatchObject({ events: [], reset: true });

    // Retention: old events are removed, and a reader who was behind them is told to start again rather than silently missing them.
    const current = (await feed(as(alice))).nextCursor; const kept = await h.data.insert(as(alice), id, access, { owner: alice, body: 'recent' }); void kept;
    const after = (await feed(as(alice), current)); expect(after.seen).toHaveLength(1);
    await h.sql`UPDATE data_change_events SET occurred_at = now() - interval '100 hours' WHERE table_id = ${id}`;
    const late = await h.data.insert(as(alice), id, access, { owner: alice, body: 'after the cut' });
    expect(await h.data.pruneChanges(72)).toBeGreaterThan(5); expect(await h.sql`SELECT 1 FROM data_change_events WHERE table_id = ${id}`).toHaveLength(1);
    expect(await feed(as(alice), current)).toMatchObject({ events: [], reset: true });
    // A reader who had already read up to the cut continues normally.
    expect((await feed(as(alice), after.nextCursor)).seen).toEqual([['insert', late.id, '1']]); expect((await feed(as(alice), after.nextCursor)).reset).toBe(false);
    expect(await h.data.pruneChanges(72)).toBe(0);
  });

  test('user keys can be added, replaced and cleared atomically without replacing internal row identities', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid(); const actor = app(authority, user);
    await h.data.create(authority, id, { ...definition(), columns: [...definition().columns, { name: 'slug', type: 'text', nullable: true }, { name: 'number', type: 'integer', nullable: false, default: { kind: 'literal', value: '1' } }] });
    const first = await h.data.insert(actor, id, access, { owner: user, slug: 'duplicate' });
    const second = await h.data.insert(actor, id, access, { owner: user, slug: 'duplicate' });
    const command = (revision: string, column: string | null, confirmation?: string, commandId = uuid()) => h.data.command(authority, { kind: 'table.alter', tableId: id, commandId, revision, change: { kind: 'primary-key', column }, confirmation });
    const preview = await h.data.preview(authority, id, { kind: 'primary-key', column: 'slug' });
    expect(preview.destructive).toBe(false); expect(preview.definition.columns.find(column => column.name === 'slug')!.nullable).toBe(false);
    expect((await rejected(command('1', 'slug'))).errno).toBe('23505');
    expect((await h.data.get(authority, id)).definition.columns.find(column => column.name === 'slug')!.nullable).toBe(true);
    const changed = await h.data.update(actor, id, access, second.id, '1', { slug: null });
    expect((await rejected(command('1', 'slug'))).errno).toBe('23502');
    await h.data.update(actor, id, access, second.id, changed.revision, { slug: 'second' });
    const keyId = uuid(); const receipt = await command('1', 'slug', undefined, keyId); expect(receipt.revision).toBe('2');
    expect(await command('1', 'slug', undefined, keyId)).toEqual(receipt);
    expect((await rejected(h.data.insert(actor, id, access, { owner: user, slug: 'second' }))).errno).toBe('23505');
    expect((await rejected(command('2', 'number'))).code).toBe('validation');
    expect((await rejected(command('2', 'number', 'notes'))).errno).toBe('23505');
    expect((await h.data.get(authority, id)).definition.primaryKey).toBe('slug');
    await h.data.update(actor, id, access, first.id, first.revision, { number: '2' });
    expect((await command('2', 'number', 'notes')).revision).toBe('3');
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const target = `"${names.schema}"."ct_${id.replaceAll('-', '')}"`;
    await h.sql.unsafe(`CREATE TABLE "${names.schema}".key_child (parent bigint REFERENCES ${target} (number))`);
    const clearId = uuid(); expect((await rejected(command('3', null, 'notes', clearId))).errno).toBe('2BP01');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${clearId}`).toHaveLength(0);
    expect((await h.data.get(authority, id)).revision).toBe('3');
    await h.sql.unsafe(`DROP TABLE "${names.schema}".key_child`);
    expect((await command('3', null, 'notes', clearId)).revision).toBe('4');
    const cleared = await h.data.get(authority, id); expect(cleared.definition.primaryKey).toBeUndefined();
    expect(cleared.definition.columns.find(column => column.name === 'number')!.nullable).toBe(false);
    expect((await h.data.query(actor, id, access)).map(row => row.id).sort()).toEqual([first.id, second.id].sort());
    expect((await rejected(command('4', 'payload'))).code).toBe('validation');
    // Exercise adoption of the exact unique constraint shape produced by the earlier canonical writer.
    await command('4', 'number');
    const managed = 'carbon_pk_' + id.replaceAll('-', '');
    await h.sql.unsafe(`ALTER TABLE ${target} DROP CONSTRAINT "${managed}"`);
    await h.sql.unsafe(`ALTER TABLE ${target} ADD UNIQUE (number)`);
    expect((await command('5', null, 'notes')).revision).toBe('6');
    await command('6', 'number');
    await h.sql.unsafe(`ALTER TABLE ${target} ADD CONSTRAINT duplicate_key_fixture UNIQUE (number)`);
    expect((await rejected(command('7', null, 'notes'))).code).toBe('conflict');
    expect((await h.data.get(authority, id)).revision).toBe('7');
    await h.sql.unsafe(`ALTER TABLE ${target} DROP CONSTRAINT duplicate_key_fixture`);
    let checks = 0; const revokedId = uuid();
    expect((await rejected(h.data.command({ ...authority, permit: async () => ++checks < 3 }, { kind: 'table.alter', tableId: id, commandId: revokedId, revision: '7', change: { kind: 'primary-key', column: null }, confirmation: 'notes' }))).code).toBe('forbidden');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${revokedId}`).toHaveLength(0);
    expect((await h.data.get(authority, id)).definition.primaryKey).toBe('number');
    expect((await rejected(h.data.insert(actor, id, access, { owner: user, slug: 'third', number: '1' }))).errno).toBe('23505');
    expect((await h.data.create(authority, uuid(), { ...definition(), name: 'another_key', primaryKey: 'owner' })).revision).toBe('1');
  });
  test('schema changes preserve rows and owner policies, require revisions and confirmation, and roll back DDL with receipts', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid();
    await h.data.create(authority, id, { ...definition(), primaryKey: 'owner' });
    const actor = app(authority, user); const row = await h.data.insert(actor, id, access, { owner: user });
    const alter = (revision: string, change: DataSchemaChange, confirmation?: string, commandId = uuid()) => h.data.command(authority, { kind: 'table.alter', tableId: id, commandId, revision, change, confirmation });
    const change: DataSchemaChange = { kind: 'column.edit', original: 'owner', column: { name: 'accountOwner', type: 'text', nullable: false } };
    const preview = await h.data.preview(authority, id, change); expect(preview.revision).toBe('1'); expect(preview.destructive).toBe(true);
    expect(preview.dependencies).toContain('primary-key'); expect(preview.definition.primaryKey).toBe('accountOwner');
    expect((await h.data.get(authority, id)).definition.primaryKey).toBe('owner');
    expect((await rejected(alter('1', change))).code).toBe('validation');
    const commandId = uuid(); const receipt = await alter('1', change, 'notes', commandId); expect(receipt.revision).toBe('2');
    expect(await alter('1', change, 'notes', commandId)).toEqual(receipt);
    expect((await h.data.query(actor, id, access))[0]!.values.accountOwner).toBe(user);
    expect(await h.data.query(app(authority, uuid()), id, access)).toHaveLength(0);
    expect((await h.data.get(authority, id)).definition.policies.rules[0]).toMatchObject({ ownerColumn: 'accountOwner' });
    expect((await rejected(alter('1', { kind: 'rename', name: 'stale' }))).code).toBe('conflict');
    expect((await alter('2', { kind: 'column.add', column: { name: 'extra', type: 'integer', nullable: false, default: { kind: 'literal', value: '9007199254740993' } } })).revision).toBe('3');
    expect((await h.data.query(actor, id, access))[0]!.values.extra).toBe('9007199254740993');
    expect((await alter('3', { kind: 'column.edit', original: 'extra', column: { name: 'extra', type: 'decimal', nullable: true } }, 'notes')).revision).toBe('4');
    const failedId = uuid();
    await rejected(alter('4', { kind: 'column.edit', original: 'body', column: { name: 'body', type: 'integer', nullable: false } }, 'notes', failedId));
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${failedId}`).toHaveLength(0);
    expect((await h.data.get(authority, id)).revision).toBe('4');
    expect((await h.data.query(actor, id, access))[0]!.values.body).toBe(row.values.body);
    expect((await rejected(alter('4', { kind: 'column.drop', name: 'accountOwner' }, 'notes'))).code).toBe('conflict');
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId); const target = `"${names.schema}"."ct_${id.replaceAll('-', '')}"`;
    await h.sql.unsafe(`CREATE INDEX fixture_extra_index ON ${target} (extra)`);
    expect((await rejected(alter('4', { kind: 'column.drop', name: 'extra' }, 'notes'))).code).toBe('conflict');
    await h.sql.unsafe(`DROP INDEX "${names.schema}".fixture_extra_index`);
    expect((await alter('4', { kind: 'column.drop', name: 'extra' }, 'notes')).revision).toBe('5');
    expect((await h.data.query(actor, id, access))[0]!.values).not.toHaveProperty('extra');
    expect((await alter('5', { kind: 'rename', name: 'renamed' })).revision).toBe('6');
    expect((await h.data.get(authority, id)).definition.name).toBe('renamed');
    let checks = 0; const revokedId = uuid();
    expect((await rejected(h.data.command({ ...authority, permit: async () => ++checks < 3 }, { kind: 'table.alter', commandId: revokedId, tableId: id, revision: '6', change: { kind: 'column.add', column: { name: 'revoked', type: 'text', nullable: true } } }))).code).toBe('forbidden');
    expect(await h.sql`SELECT command_id FROM canonical_data_commands WHERE command_id = ${revokedId}`).toHaveLength(0);
    expect((await h.data.get(authority, id)).definition.columns.some(column => column.name === 'revoked')).toBe(false);
    expect(await h.data.query(actor, id, access)).toHaveLength(1);
    expect((await alter('6', { kind: 'column.add', column: { name: 'optional', type: 'text', nullable: true } })).revision).toBe('7');
    await rejected(alter('7', { kind: 'column.edit', original: 'optional', column: { name: 'optional', type: 'text', nullable: false } }));
    const afterFailure = await h.data.get(authority, id); expect(afterFailure.revision).toBe('7');
    expect(afterFailure.definition.columns.find(column => column.name === 'optional')!.nullable).toBe(true);
  });
  test('typed row sorting keeps exact keys, UUID ties and nulls-last cursors across omitted projections and revision changes', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid();
    const types = ['text', 'integer', 'decimal', 'boolean', 'timestamp', 'uuid', 'json', 'jsonb', 'text[]', 'integer[]'] as const;
    const columns = types.map((type, index) => ({ name: 'col' + index, type, nullable: true }));
    await h.data.create(authority, id, { name: 'ordered', columns: [{ name: 'owner', type: 'uuid', nullable: false }, ...columns], policies: definition().policies });
    const actor = app(authority, user);
    const low = ['A', '-9007199254740993', '9007199254740993.123456789', false, '2020-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000001', 1, 1, ['a'], ['-9007199254740993']];
    const high = ['z', '9007199254740993', '9007199254740993.12345679', true, '2021-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000002', 2, 2, ['b'], ['9007199254740993']];
    const values = (items: unknown[], owner = user) => ({ owner, ...Object.fromEntries(columns.map((column, index) => [column.name, items[index]])) });
    const first = await h.data.insert(actor, id, access, values(low));
    const higher = [await h.data.insert(actor, id, access, values(high)), await h.data.insert(actor, id, access, values(high))].sort((a,b) => a.id.localeCompare(b.id));
    const nils = [await h.data.insert(actor, id, access, values(types.map(() => null))), await h.data.insert(actor, id, access, values(types.map(() => null)))].sort((a,b) => a.id.localeCompare(b.id));
    const other = uuid(); await h.data.insert(app(authority, other), id, access, values(low, other));
    for (const column of columns) for (const direction of ['asc', 'desc'] as const) {
      let afterId: string | undefined; let afterSort: DataRowBoundary | undefined; const seen: string[] = [];
      for (let step = 0; step < 6; step++) {
        const result = await h.data.queryPage(actor, { kind: 'rows.query', tableId: id, access, limit: 1, columns: [], sort: { column: column.name, direction }, afterId, afterSort });
        expect(result.rows[0]!.values).toEqual({}); seen.push(result.rows[0]!.id);
        if (!result.nextAfterId) { expect(result.nextSort).toBeUndefined(); break; }
        expect(result.nextSort!.revision).toBe('1'); afterId = result.nextAfterId; afterSort = result.nextSort;
      }
      expect(seen).toEqual(direction === 'asc' ? [first.id, ...higher.map(row => row.id), ...nils.map(row => row.id)] : [...higher.map(row => row.id), first.id, ...nils.map(row => row.id)]);
    }
    const query: DataQuery = { kind: 'rows.query', tableId: id, access, limit: 1, columns: ['owner'], sort: { column: 'col2', direction: 'asc' } };
    const start = await h.data.queryPage(actor, query); expect(start.nextSort!.value).toBe(low[2]);
    await h.data.delete(actor, id, access, first.id, '1');
    expect((await h.data.queryPage(actor, { ...query, afterId: start.nextAfterId!, afterSort: start.nextSort })).rows[0]!.id).toBe(higher[0]!.id);
    expect((await rejected(h.data.queryPage(actor, { ...query, afterId: start.nextAfterId! }))).code).toBe('validation');
    await h.data.replacePolicies(authority, id, '1', definition().policies);
    expect((await rejected(h.data.queryPage(actor, { ...query, afterId: start.nextAfterId!, afterSort: start.nextSort }))).code).toBe('conflict');
    // JSON null is a sortable JSON value, distinct from SQL NULL.
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
    await h.sql.unsafe(`UPDATE "${names.schema}"."ct_${id.replaceAll('-', '')}" SET col7 = 'null'::jsonb WHERE _carbon_id = $1::uuid`, [higher[0]!.id]);
    const jsonQuery: DataQuery = { ...query, sort: { column: 'col7', direction: 'asc' } };
    const jsonNull = await h.data.queryPage(actor, jsonQuery); expect(jsonNull.nextSort!.value).toBeNull(); expect(jsonNull.nextSort!.sqlNull).toBe(false);
    const numeric = await h.data.queryPage(actor, { ...jsonQuery, afterId: jsonNull.nextAfterId!, afterSort: jsonNull.nextSort });
    expect(numeric.nextSort!.value).toBe(2);
  });
  test('structured queries preserve exact values, JSON paths, literal text and row policies under projections and selected IDs', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid(); const foreign = uuid();
    await h.data.create(authority, id, { ...definition(), columns: [...definition().columns,
      { name: 'optional', type: 'text', nullable: true }, { name: 'tags', type: 'text[]', nullable: false }, { name: 'flag', type: 'boolean', nullable: false }] });
    const alice = app(authority, user); const bob = app(authority, foreign);
    const tags = ['a', 'b', 'comma,brace{}', 'slash\\quote"', 'NULL', ''];
    const first = await h.data.insert(alice, id, access, { owner: user, body: 'one_%', tags, flag: true, numbers: ['9007199254740993', '-8'],
      payload: { nested: { count: 4, note: 'hello', nothing: null }, "x') OR true --": 'exact', 'slash\\quote"': 'escaped path' } });
    expect(first.values.tags).toEqual(tags); expect(first.values.numbers).toEqual(['9007199254740993', '-8']);
    const second = await h.data.insert(alice, id, access, { owner: user, body: 'two', amount: '9007199254740993.12345679', optional: 'present', tags: ['b'], flag: false, payload: { nested: { count: '5' } } });
    const hidden = await h.data.insert(bob, id, access, { owner: foreign, body: 'one_%', tags: ['a'], flag: true });
    const query = (selection: Parameters<typeof h.data.query>[5]) => h.data.query(alice, id, access, 100, undefined, selection);
    expect((await query({ filters: [{ column: 'amount', operator: 'eq', value: '9007199254740993.123456789' }], columns: ['amount'] }))).toEqual([{ id: first.id, revision: '1', values: { amount: '9007199254740993.123456789' } }]);
    expect((await query({ filters: [{ column: 'amount', operator: 'gt', value: '9007199254740993.123456789' }] })).map(row => row.id)).toEqual([second.id]);
    expect((await query({ filters: [{ column: 'amount', operator: 'lt', value: '9007199254740993.12345679' }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'body', operator: 'contains', value: '_%' }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'body', operator: 'ne', value: 'two' }, { column: 'flag', operator: 'eq', value: true }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'optional', operator: 'is-null' }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'optional', operator: 'ne', value: null }] })).map(row => row.id)).toEqual([second.id]);
    expect((await query({ filters: [{ column: 'tags', operator: 'contains', value: ['a'] }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'tags', operator: 'contains', value: ['slash\\quote"', 'NULL', ''] }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'numbers', operator: 'contains', value: ['9007199254740993'] }], selectedIds: [first.id, hidden.id], columns: [] }))).toEqual([{ id: first.id, revision: '1', values: {} }]);
    expect(await query({ selectedIds: [] })).toHaveLength(0);
    expect((await query({ filters: [{ column: 'payload', path: ['nested', 'count'], operator: 'gt', value: 3 }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'payload', operator: 'contains', value: { nested: { note: 'hello' } } }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'payload', path: ["x') OR true --"], operator: 'eq', value: 'exact' }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'payload', path: ['slash\\quote"'], operator: 'eq', value: 'escaped path' }] })).map(row => row.id)).toEqual([first.id]);
    expect((await query({ filters: [{ column: 'payload', path: ['nested', 'nothing'], operator: 'is-null' }] }))).toHaveLength(2);
    for (const selection of [
      { columns: ['unknown'] }, { filters: [{ column: 'body', path: ['invalid'], operator: 'eq', value: 'x' }] },
      { filters: [{ column: 'flag', operator: 'gt', value: false }] }, { filters: [{ column: 'body', operator: 'is-null', value: true }] },
      { filters: [{ column: 'amount', operator: 'contains', value: '1' }] }, { filters: [{ column: 'body', operator: 'eq' }] },
    ]) expect((await rejected(query(selection as any))).code).toBe('validation');
    const updated = await h.data.update(alice, id, access, first.id, '1', { tags: ['new,\\"'], numbers: [] });
    expect(updated.values.tags).toEqual(['new,\\"']); expect(updated.values.numbers).toEqual([]);
  });
  test('table name filters are literal and ordered cursors preserve ascending and descending boundaries', async () => {
    const h = await harness(); const actor = h.environments[0]!;
    const names = ['Zebra', 'alpha', 'Alpha', 'note_one', 'noteXone'];
    const entries: { id: string; name: string }[] = [];
    for (const name of names) { const id = uuid(); entries.push({ id, name }); await h.data.create(actor, id, { ...definition(), name }); }
    for (const sort of ['id', '-id', 'name', '-name'] as const) {
      const expected = [...entries].sort((a,b) => (sort.includes('name') ? a.name < b.name ? -1 : a.name > b.name ? 1 : 0 : a.id < b.id ? -1 : 1) * (sort.startsWith('-') ? -1 : 1));
      const actual: string[] = []; let afterId: string | undefined; let afterName: string | undefined;
      for (let page = 0; page < 4; page++) {
        const result = await h.data.list(actor, { kind: 'tables.list', sort, limit: 2, ...(afterId ? { afterId } : {}), ...(afterName ? { afterName } : {}) });
        actual.push(...result.tables.map(table => table.id)); if (!result.nextAfterId) break;
        afterId = result.nextAfterId; afterName = result.nextAfterName;
      }
      expect(actual).toEqual(expected.map(table => table.id));
    }
    expect((await h.data.list(actor, { kind: 'tables.list', name: 'ALPHA', sort: 'name' })).tables.map(table => table.name)).toEqual(['Alpha', 'alpha']);
    expect((await h.data.list(actor, { kind: 'tables.list', name: '_' })).tables.map(table => table.name)).toEqual(['note_one']);
    expect((await h.data.list(actor, { kind: 'tables.list', name: '%' })).tables).toHaveLength(0);
    expect((await h.data.list(actor, { kind: 'tables.list', name: "' OR true --" })).tables).toHaveLength(0);
    expect((await rejected(h.data.list(actor, { kind: 'tables.list', sort: 'name', afterId: entries[0]!.id }))).code).toBe('validation');
    expect((await rejected(h.data.list(actor, { kind: 'tables.list', afterName: 'Zebra' }))).code).toBe('validation');
    // Continue from a deleted anchor without re-resolving it or skipping its original boundary.
    const first = await h.data.list(actor, { kind: 'tables.list', sort: 'name', limit: 1 });
    await h.sql`DELETE FROM canonical_data_events WHERE table_id = ${first.nextAfterId!}`;
    await h.sql`DELETE FROM canonical_data_tables WHERE id = ${first.nextAfterId!}`;
    const continued = await h.data.list(actor, { kind: 'tables.list', sort: 'name', afterId: first.nextAfterId!, afterName: first.nextAfterName! });
    expect(continued.tables.map(table => table.name)).toEqual(['Zebra', 'alpha', 'noteXone', 'note_one']);
  });
  test('metadata reads isolate environments, reject app identities, recheck authority and remain available when paused', async () => {
    const h = await harness(); const [a, b] = h.environments as [NativeDataAuthority, NativeDataAuthority];
    const ids = [uuid(), uuid()].sort();
    await h.data.create(a, ids[0]!, definition()); await h.data.create(a, ids[1]!, { ...definition(), name: 'other' });
    await h.data.create(b, uuid(), definition());
    const metadata = { ...a, permit: async (permission: string) => permission === 'metadata.read' };
    const page = await h.data.list(metadata, { kind: 'tables.list', limit: 1 });
    expect(page.tables.map(table => table.id)).toEqual([ids[0]!]); expect(page.nextAfterId).toBe(ids[0]!);
    const last = await h.data.list(metadata, { kind: 'tables.list', limit: 1, afterId: page.nextAfterId! });
    expect(last.tables.map(table => table.id)).toEqual([ids[1]!]); expect(last.nextAfterId).toBeNull();
    expect((await rejected(h.data.get(b, ids[0]!))).code).toBe('not_found');
    expect((await rejected(h.data.get(app(a, uuid()), ids[0]!))).code).toBe('forbidden');
    expect((await rejected(h.data.list(app(a, uuid()), { kind: 'tables.list' }))).code).toBe('forbidden');
    let checks = 0;
    expect((await rejected(h.data.get({ ...metadata, permit: async () => ++checks === 1 }, ids[0]!))).code).toBe('forbidden');
    await h.sql.begin(async tx => { await h.driver.setState(tx, a.scope, '', 'paused'); await tx`UPDATE platform_environments SET state = 'paused' WHERE environment_id = ${a.scope.environmentId}`; });
    expect((await h.data.list(metadata, { kind: 'tables.list' })).tables).toHaveLength(2);
    expect((await h.data.get(metadata, ids[0]!)).revision).toBe('1');
    expect((await h.sql`SELECT indexname FROM pg_indexes WHERE indexname = 'canonical_data_tables_scope_page'`)).toHaveLength(1);
  });
  test('real native RLS isolates users and environments and enforces old/proposed ownership with exact values', async () => {
    const h = await harness(); const a = h.environments[0]!; const b = h.environments[1]!; const tableId = uuid(); const userA = uuid(); const userB = uuid();
    await h.data.create(a, tableId, definition());
    const alice = app(a, userA); const bob = app(a, userB);
    const row = await h.data.insert(alice, tableId, access, { owner: userA });
    expect(row.values).toEqual({ owner: userA, body: "O'Reilly \\ default", amount: '9007199254740993.123456789', sequence: '9007199254740993', payload: { safe: true }, numbers: ['9007199254740993'] });
    expect((await h.data.query(alice, tableId, access)).map(item => item.id)).toEqual([row.id]);
    expect(await h.data.query(bob, tableId, access)).toHaveLength(0);
    expect((await rejected(h.data.insert(bob, tableId, access, { owner: userA }))).errno).toBe('42501');
    expect((await rejected(h.data.update(alice, tableId, access, row.id, row.revision, { owner: userB }))).errno).toBe('42501');
    expect((await rejected(h.data.update(bob, tableId, access, row.id, row.revision, { body: 'attack' }))).code).toBe('conflict');
    expect((await rejected(h.data.query(app(b, userA), tableId, access))).code).toBe('not_found');
    const changed = await h.data.update(alice, tableId, access, row.id, row.revision, { body: 'changed', payload: { nested: ['safe'] } });
    expect(changed.revision).toBe('2'); expect(changed.values.payload).toEqual({ nested: ['safe'] });
    expect((await rejected(h.data.delete(alice, tableId, access, row.id, '1'))).code).toBe('conflict');
    await h.data.delete(alice, tableId, access, row.id, '2'); expect(await h.data.query(alice, tableId, access)).toHaveLength(0);
    const names = databaseEnvironmentIdentifiers(a.scope.environmentId);
    const flags = await h.sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${names.schema} AND c.relname = ${'ct_' + tableId.replaceAll('-', '')}`;
    expect(flags[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const state = await h.sql`SELECT current_user, session_user, current_setting('carbon.user_id', true) AS context`;
    expect(state[0].current_user).toBe(state[0].session_user); expect(state[0].context ?? '').toBe('');
    const events = await h.sql`SELECT detail FROM canonical_data_events WHERE table_id = ${tableId}`;
    expect(events.length).toBeGreaterThan(3); expect(JSON.stringify(events)).not.toContain('nested');
  });

  test('public reads require matching native scope; revisioned policy replacement and pause remain effective across reconstruction', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const userId = uuid();
    await h.data.create(authority, id, definition());
    const actor = app(authority, userId); await h.data.insert(actor, id, access, { owner: userId });
    const publicPolicy = { enabled: true, rules: [{ id: uuid(), name: 'Public read', kind: 'public-read' as const, operations: ['select'] as const }] };
    const updated = await h.data.replacePolicies(authority, id, '1', publicPolicy); expect(updated.revision).toBe('2');
    const recreated = new PostgresNativeTables(h.sql);
    expect(await recreated.query(authority, id, { mode: 'policy-preview' })).toHaveLength(1);
    expect((await rejected(recreated.insert(actor, id, access, { owner: userId }))).errno).toBe('42501');
    expect((await rejected(recreated.replacePolicies(authority, id, '1', publicPolicy))).code).toBe('conflict');
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
    const unscoped = await h.sql.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE "${names.role}"`); return tx.unsafe(`SELECT * FROM "${names.schema}"."ct_${id.replaceAll('-', '')}"`); });
    expect(unscoped).toHaveLength(0);
    const foreignScope = await h.sql.begin(async tx => {
      await tx`SELECT set_config('carbon.org_id', ${h.environments[1]!.scope.orgId}, true), set_config('carbon.project_id', ${authority.scope.projectId}, true), set_config('carbon.environment_id', ${authority.scope.environmentId}, true)`;
      await tx.unsafe(`SET LOCAL ROLE "${names.role}"`); return tx.unsafe(`SELECT * FROM "${names.schema}"."ct_${id.replaceAll('-', '')}"`);
    });
    expect(foreignScope).toHaveLength(0);
    expect((await rejected(recreated.query(actor, id, { mode: 'policy-preview', userId }))).code).toBe('forbidden');
    await h.sql.begin(async tx => { await h.driver.setState(tx, authority.scope, '', 'paused'); await tx`UPDATE platform_environments SET state = 'paused' WHERE environment_id = ${authority.scope.environmentId}`; });
    expect(await recreated.query(authority, id, { mode: 'policy-preview' })).toHaveLength(1);
    expect((await rejected(recreated.insert(actor, id, access, { owner: userId }))).code).toBe('conflict');
    await h.sql.begin(async tx => { await h.driver.setState(tx, authority.scope, '', 'active'); await tx`UPDATE platform_environments SET state = 'active' WHERE environment_id = ${authority.scope.environmentId}`; });
    await recreated.replacePolicies(authority, id, '2', { enabled: false, rules: [] });
    expect(await recreated.query(authority, id, { mode: 'policy-preview' })).toHaveLength(0);
  });

  test('live authority rejection rolls back native DDL, policies, rows and audit records', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid();
    let checks = 0; const revoked = { ...authority, permit: async () => ++checks === 1 };
    expect((await rejected(h.data.create(revoked, id, definition()))).code).toBe('forbidden');
    expect(await h.sql`SELECT id FROM canonical_data_tables WHERE id = ${id}`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM canonical_data_events WHERE table_id = ${id}`).toHaveLength(0);
    await h.data.create(authority, id, definition()); const user = uuid(); const actor = app(authority, user);
    checks = 0;
    expect((await rejected(h.data.insert({ ...actor, permit: async () => ++checks === 1 }, id, access, { owner: user }))).code).toBe('forbidden');
    expect(await h.data.query(actor, id, access)).toHaveLength(0);
    checks = 0;
    expect((await rejected(h.data.replacePolicies(revoked, id, '1', { enabled: false, rules: [] }))).code).toBe('forbidden');
    expect((await h.sql`SELECT revision::text FROM canonical_data_tables WHERE id = ${id}`)[0].revision).toBe('1');
    await h.data.insert(actor, id, access, { owner: user });
    expect(await h.data.query(actor, id, access)).toHaveLength(1);
  });

  test('native checks bound derived row sizes and BEFORE-trigger owner changes cannot bypass RLS', async () => {
    const h = await harness(); const authority = h.environments[0]!; const id = uuid(); const user = uuid();
    await h.data.create(authority, id, definition());
    const names = databaseEnvironmentIdentifiers(authority.scope.environmentId);
    await h.sql.unsafe(`CREATE FUNCTION public.native_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.owner := '${uuid()}'::uuid; RETURN NEW; END $$`);
    await h.sql.unsafe(`CREATE TRIGGER native_owner_change BEFORE INSERT ON "${names.schema}"."ct_${id.replaceAll('-', '')}" FOR EACH ROW EXECUTE FUNCTION public.native_owner_change()`);
    expect((await rejected(h.data.insert(app(authority, user), id, access, { owner: user }))).errno).toBe('42501');
    expect(await h.data.query(app(authority, user), id, access)).toHaveLength(0);
    const large = definition(); const largeId = uuid();
    await h.data.create(authority, largeId, { ...large, name: 'large_defaults', columns: [...large.columns, ...['first', 'second', 'third', 'fourth'].map(name => ({ name, type: 'text' as const, nullable: false, default: { kind: 'literal' as const, value: 'x'.repeat(16384) } }))] });
    expect((await rejected(h.data.insert(app(authority, user), largeId, access, { owner: user }))).errno).toBe('23514');
    expect(await h.data.query(app(authority, user), largeId, access)).toHaveLength(0);
  });
});
