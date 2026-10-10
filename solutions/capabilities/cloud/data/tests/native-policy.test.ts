import { expect, test } from 'bun:test';
import { validateDefinition, validatePolicies, validateValue, identifier, type NativeDefinition } from '../domain/NativeTable.ts';
const id = '11111111-1111-4111-8111-111111111111';
const columns = [{ name: 'owner', type: 'uuid', nullable: false }] as const;
const definition: NativeDefinition = { name: 'notes', columns, policies: { enabled: true, rules: [{ id, name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } };

test('managed constraint definitions reject unknown expressions, invalid dependencies and duplicate identities', () => {
  const unique = { id, name: 'owner_unique', kind: 'unique', columns: ['owner'] };
  expect(() => validateDefinition({ ...definition, constraints: [unique] } as NativeDefinition)).not.toThrow();
  for (const constraints of [
    [unique, unique], [unique, { ...unique, id: '22222222-2222-4222-8222-222222222222' }],
    [{ ...unique, columns: ['missing'] }], [{ ...unique, columns: ['owner', 'owner'] }],
    [{ ...unique, kind: 'check', check: { column: 'owner', operator: 'sql', value: 'true' } }],
    [{ ...unique, kind: 'check', check: { column: 'missing', operator: 'ne', value: id } }],
    [{ ...unique, kind: 'check', check: { column: 'owner', operator: 'ne', value: null } }],
    [{ ...unique, expression: 'pg_read_file' }],
  ]) expect(() => validateDefinition({ ...definition, constraints } as any)).toThrow();
});
test('native policy definitions reject SQL, invalid owner columns, unknown fields and implicit write grants', () => {
  expect(validateDefinition(definition)).toEqual(definition);
  for (const name of ['pg_catalog.tables', 'a;DROP TABLE b', 'a"', '_carbon_id', '', 'a'.repeat(64)]) expect(() => identifier(name)).toThrow();
  for (const policy of [null, {}, { ...definition.policies.rules[0], kind: 'sql', sql: 'true' }, { ...definition.policies.rules[0], ownerColumn: 'missing' },
    { id, name: 'Public', kind: 'public-read', operations: ['insert'] }, { ...definition.policies.rules[0], operations: ['select', 'select'] }]) {
    expect(() => validatePolicies({ enabled: true, rules: [policy] } as any, columns)).toThrow();
  }
  expect(() => validateDefinition({ ...definition, columns: [{ ...columns[0], default: { kind: 'sql', value: 'pg_read_file()' } }] } as any)).toThrow();
  expect(() => validateDefinition({ ...definition, columns: [{ ...columns[0], type: 'text; DROP ROLE postgres' }] } as any)).toThrow();
  expect(() => validateValue({ name: 'n', type: 'decimal', nullable: false }, 9007199254740992)).toThrow();
  expect(() => validateValue({ name: 'n', type: 'integer', nullable: false }, '9223372036854775808')).toThrow();
  expect(() => validateValue({ name: 'j', type: 'jsonb', nullable: false }, { value: NaN })).toThrow();
  expect(() => validateValue({ name: 'n', type: 'decimal', nullable: false }, '9007199254740993.123456789')).not.toThrow();
});
