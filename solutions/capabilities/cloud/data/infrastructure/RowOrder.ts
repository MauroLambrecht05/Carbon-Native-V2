import { PlatformFault, type DataQuery } from '@carbon/contracts/platform';
import { identifier, pgTypes, validateValue, type NativeDefinition } from '../domain/NativeTable.ts';
import { postgresArray } from './PostgresParameters.ts';

export function compileRowOrder(query: DataQuery, definition: NativeDefinition, revision: string, parameters: unknown[]) {
  if (!query.sort) {
    if (query.afterSort !== undefined) throw new PlatformFault('validation', 'Unexpected row sort boundary');
    return { order: '_carbon_id ASC', where: '($1::uuid IS NULL OR _carbon_id > $1::uuid)', select: '' };
  }
  const column = definition.columns.find(column => column.name === query.sort!.column);
  if (!column) throw new PlatformFault('validation', 'Unknown sort column');
  if ((query.afterId !== undefined) !== (query.afterSort !== undefined)) throw new PlatformFault('validation', 'Incomplete row sort boundary');
  const json = ['json', 'jsonb'].includes(column.type); const name = identifier(column.name);
  const expression = json ? `${name}::jsonb` : ['text', 'text[]'].includes(column.type) ? `${name} COLLATE "C"` : name;
  const direction = query.sort.direction === 'desc' ? 'DESC' : 'ASC';
  const wire = ['integer', 'decimal', 'uuid'].includes(column.type) ? `${name}::text` : column.type === 'integer[]' ? `${name}::text[]` : name;
  let where = '$1::uuid IS NULL';
  if (query.afterSort) {
    const boundary = query.afterSort;
    if (boundary.revision !== revision) throw new PlatformFault('conflict', 'Table revision changed; restart the row query');
    if ((boundary.sqlNull && boundary.value !== null) || (!boundary.sqlNull && boundary.value === null && !json)) throw new PlatformFault('validation', 'Invalid null sort boundary');
    validateValue({ ...column, nullable: true }, boundary.value);
    if (boundary.sqlNull) where = `(${expression} IS NULL AND _carbon_id > $1::uuid)`;
    else {
      parameters.push(json ? JSON.stringify(boundary.value) : Array.isArray(boundary.value) ? postgresArray(boundary.value) : boundary.value);
      const value = `$${parameters.length}::${json ? 'text::jsonb' : pgTypes[column.type]}`;
      where = `(${expression} IS NULL OR ${expression} ${direction === 'ASC' ? '>' : '<'} ${value} OR (${expression} IS NOT DISTINCT FROM ${value} AND _carbon_id > $1::uuid))`;
    }
  }
  return { order: `${expression} ${direction} NULLS LAST, _carbon_id ASC`, where,
    select: `, ${wire} AS _carbon_sort_value, (${expression} IS NULL) AS _carbon_sort_null` };
}
