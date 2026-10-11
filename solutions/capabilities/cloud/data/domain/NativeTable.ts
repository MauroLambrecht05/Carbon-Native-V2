import { PlatformFault, parseComponent } from '@carbon/contracts/platform';
import type { DataColumn, DataPolicy, DataPolicySet, DataTableDefinition, DataConstraint } from '@carbon/contracts/platform';

export type NativeColumn = DataColumn;
export type NativeColumnType = NativeColumn['type'];
export type NativePolicy = DataPolicy;
export type NativePolicySet = DataPolicySet;
export type NativeDefinition = DataTableDefinition;
export const pgTypes: Record<NativeColumnType, string> = { text: 'text', integer: 'bigint', decimal: 'numeric', boolean: 'boolean', timestamp: 'timestamptz', uuid: 'uuid', json: 'json', jsonb: 'jsonb', 'text[]': 'text[]', 'integer[]': 'bigint[]' };
const fail = (): never => { throw new PlatformFault('validation', 'Invalid native table or policy definition'); };
export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value)) fail();
  return `"${value}"`;
}
function shape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
}
export function validateValue(column: NativeColumn, value: unknown): void {
  if (value === null) { if (!column.nullable) fail(); return; }
  switch (column.type) {
    case 'text': if (typeof value !== 'string' || value.length > 16384 || value.includes('\0')) fail(); break;
    case 'integer': if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]{0,18})$/.test(value) || BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n) fail(); break;
    case 'decimal': parseComponent('Decimal', value); break;
    case 'boolean': if (typeof value !== 'boolean') fail(); break;
    case 'uuid': parseComponent('Id', value); break;
    case 'timestamp': parseComponent('Timestamp', value); break;
    case 'text[]': case 'integer[]':
      if (!Array.isArray(value) || value.length > 1000) fail();
      for (const item of value as unknown[]) validateValue({ ...column, type: column.type === 'text[]' ? 'text' : 'integer', nullable: false }, item);
      break;
    case 'json': case 'jsonb': {
      const check = (item: unknown, depth: number): void => {
        if (depth > 16) fail();
        if (item === null || typeof item === 'boolean') return;
        if (typeof item === 'string') { if (item.includes('\0')) fail(); return; }
        if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return; }
        if (Array.isArray(item)) { for (const child of item) check(child, depth + 1); return; }
        if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
          for (const [key, child] of Object.entries(item)) { if (key.includes('\0')) fail(); check(child, depth + 1); } return;
        }
        fail();
      };
      check(value, 0); if (JSON.stringify(value).length > 65536) fail(); break;
    }
    default: fail();
  }
}
export function validatePolicies(input: NativePolicySet, columns: readonly NativeColumn[]): NativePolicySet {
  shape(input, ['enabled', 'rules']);
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 32) fail();
  const ids = new Set<string>();
  for (const rule of input.rules as NativePolicy[]) {
    shape(rule, ['id', 'name', 'kind', 'operations', 'ownerColumn']);
    parseComponent('Id', rule.id);
    if (ids.has(rule.id) || typeof rule.name !== 'string' || rule.name.length < 1 || rule.name.length > 128 || /[\u0000-\u001f]/.test(rule.name)) fail(); ids.add(rule.id);
    if (!Array.isArray(rule.operations) || rule.operations.length < 1 || rule.operations.length > 4 || new Set(rule.operations).size !== rule.operations.length) fail();
    if (rule.kind === 'owner') {
      identifier(rule.ownerColumn);
      const owner = columns.find(column => column.name === rule.ownerColumn);
      if (!owner || !['uuid', 'text'].includes(owner.type) || rule.operations.some(operation => !['select', 'insert', 'update', 'delete'].includes(operation))) fail();
    } else if (rule.kind !== 'public-read' || Object.hasOwn(rule, 'ownerColumn') || rule.operations.length !== 1 || rule.operations[0] !== 'select') fail();
  }
  return input;
}
export function validateDefinition(input: NativeDefinition): NativeDefinition {
  shape(input, ['name', 'columns', 'primaryKey', 'policies', 'constraints']); identifier(input.name);
  if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 100) fail();
  const names = new Set<string>();
  for (const column of input.columns as NativeColumn[]) {
    shape(column, ['name', 'type', 'nullable', 'default']); identifier(column.name);
    if (!Object.hasOwn(pgTypes, column.type) || typeof column.nullable !== 'boolean' || names.has(column.name)) fail(); names.add(column.name);
    if (column.default !== undefined) {
      shape(column.default, column.default?.kind === 'literal' ? ['kind', 'value'] : ['kind']);
      if (column.default.kind === 'literal') validateValue(column, column.default.value);
      else if (!(column.default.kind === 'uuid' && column.type === 'uuid') && !(column.default.kind === 'now' && column.type === 'timestamp')) fail();
    }
  }
  if (input.primaryKey !== undefined) { identifier(input.primaryKey); if (!input.columns.some(column => column.name === input.primaryKey && !column.nullable && !['json', 'jsonb', 'text[]', 'integer[]'].includes(column.type))) fail(); }
  validatePolicies(input.policies, input.columns);
  const constraintIds = new Set<string>(); const constraintNames = new Set<string>();
  if (input.constraints !== undefined && (!Array.isArray(input.constraints) || input.constraints.length > 32)) fail();
  for (const constraint of input.constraints ?? []) {
    validateConstraint(constraint, input.columns);
    if (constraintIds.has(constraint.id) || constraintNames.has(constraint.name)) fail();
    constraintIds.add(constraint.id); constraintNames.add(constraint.name);
  }
  if (JSON.stringify(input).length > 262144) fail();
  return input;
}

export function validateConstraint(input: DataConstraint, columns: readonly NativeColumn[]): void {
  const constraint = parseComponent('DataConstraint', input);
  const selected = constraint.columns.map(name => columns.find(column => column.name === name) ?? fail());
  if (constraint.kind === 'check') {
    if (selected.length !== 1 || constraint.check.column !== selected[0]!.name) fail();
    const column = selected[0]!;
    if (['json', 'jsonb', 'text[]', 'integer[]'].includes(column.type) || (column.type === 'boolean' && constraint.check.operator !== 'ne')) fail();
    validateValue({ ...column, nullable: false }, constraint.check.value);
  } else if (constraint.kind === 'foreign-key') {
    // One scalar column. Whether the referenced table and its key exist and match is checked against the catalog.
    if (selected.length !== 1 || ['json', 'jsonb', 'text[]', 'integer[]', 'boolean'].includes(selected[0]!.type)) fail();
  } else if (selected.some(column => column.type === 'json')) fail();
}

export function sameConstraintRule(left: DataConstraint, right: DataConstraint): boolean {
  const shape = (constraint: DataConstraint) => [constraint.kind, constraint.columns,
    constraint.kind === 'check' ? [constraint.check.column, constraint.check.operator, constraint.check.value] : constraint.kind === 'foreign-key' ? constraint.references.tableId.toLowerCase() : null];
  return JSON.stringify(shape(left)) === JSON.stringify(shape(right));
}
