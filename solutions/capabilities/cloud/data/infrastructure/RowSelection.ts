import { PlatformFault, parseComponent, type DataRowSelection } from '@carbon/contracts/platform';
import { identifier, pgTypes, validateValue, type NativeColumn } from '../domain/NativeTable.ts';
import { postgresArray } from './PostgresParameters.ts';

const invalid = (): never => { throw new PlatformFault('validation', 'Invalid row filter or projection'); };

/** Compile only the bounded structured query language. All values and JSON paths are parameters. */
export function compileRowSelection(input: DataRowSelection, columns: readonly NativeColumn[], parameters: unknown[]) {
  const selection = parseComponent('DataRowSelection', input);
  if (Buffer.byteLength(JSON.stringify(selection)) > 65536) invalid();
  const column = (name: string) => columns.find(column => column.name === name) ?? invalid();
  const projection = selection.columns === undefined ? columns : selection.columns.map(column);
  const bind = (value: unknown, cast: string) => { parameters.push(Array.isArray(value) ? postgresArray(value) : value); return `$${parameters.length}::${cast}`; };
  const conditions: string[] = [];
  if (selection.selectedIds !== undefined) conditions.push(`_carbon_id = ANY(${bind(selection.selectedIds, 'uuid[]')})`);
  for (const filter of selection.filters ?? []) {
    const definition = column(filter.column);
    const json = definition.type === 'json' || definition.type === 'jsonb';
    if (filter.path && !json) invalid();
    let expression = identifier(definition.name);
    if (json) expression += '::jsonb';
    if (filter.path) expression = `(${expression} #> ${bind(filter.path, 'text[]')})`;
    if (filter.operator === 'is-null' || filter.value === null) {
      if (filter.operator === 'is-null' ? Object.hasOwn(filter, 'value') : !['eq', 'ne'].includes(filter.operator)) invalid();
      const nullCheck = json ? `(${expression} IS NULL OR ${expression} = 'null'::jsonb)` : `${expression} IS NULL`;
      conditions.push(filter.operator === 'ne' ? `NOT (${nullCheck})` : nullCheck); continue;
    }
    if (!Object.hasOwn(filter, 'value')) invalid();
    validateValue({ ...definition, nullable: true }, filter.value);
    if (filter.operator === 'contains') {
      if (definition.type === 'text') conditions.push(`strpos(${expression}, ${bind(filter.value, 'text')}) > 0`);
      else if (json || definition.type.endsWith('[]')) conditions.push(`${expression} @> ${bind(json ? JSON.stringify(filter.value) : filter.value, json ? 'text' : pgTypes[definition.type])}${json ? '::jsonb' : ''}`);
      else invalid();
      continue;
    }
    const operator = { eq: '=', ne: '<>', gt: '>', lt: '<' }[filter.operator];
    if (!operator) invalid();
    if (filter.operator === 'gt' || filter.operator === 'lt') {
      if (json) {
        const type = typeof filter.value;
        if (!filter.path || !['string', 'number'].includes(type)) invalid();
        conditions.push(`jsonb_typeof(${expression}) = ${bind(type, 'text')}`);
      } else if (!['text', 'integer', 'decimal', 'timestamp', 'uuid'].includes(definition.type)) invalid();
    }
    conditions.push(`${expression} ${operator} ${bind(json ? JSON.stringify(filter.value) : filter.value, json ? 'text' : pgTypes[definition.type])}${json ? '::jsonb' : ''}`);
  }
  return { columns: projection, where: conditions.length ? conditions.map(condition => `(${condition})`).join(' AND ') : 'true' };
}
