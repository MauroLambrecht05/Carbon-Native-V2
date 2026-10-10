import { parseComponent, type DataGeneratedTypes, type DataTable } from '@carbon/contracts/platform';
import { validateDefinition, type NativeColumnType } from './NativeTable.ts';

const types: Record<NativeColumnType, string> = {
  text: 'string', integer: 'string', decimal: 'string', boolean: 'boolean', timestamp: 'string', uuid: 'string',
  json: 'CarbonJson', jsonb: 'CarbonJson', 'text[]': 'string[]', 'integer[]': 'string[]',
};
const inheritedNames = new Set(['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable']);

/** Render metadata only. Defaults and check literals never become generated source. */
export function generatedTypes(input: DataTable): DataGeneratedTypes {
  const table = parseComponent('DataTable', input); const definition = validateDefinition(table.definition);
  const property = (column: typeof definition.columns[number], optional: boolean) =>
    `${JSON.stringify(column.name)}${optional ? '?' : ''}: ${types[column.type]}${column.nullable ? ' | null' : ''};`;
  const inputType = (name: string, update: boolean) => {
    const optional = (column: typeof definition.columns[number]) => update || column.nullable || column.default !== undefined;
    const inherited = definition.columns.filter(column => optional(column) && inheritedNames.has(column.name));
    const ordinary = definition.columns.filter(column => !inherited.includes(column));
    // Union branches allow an inherited JS property to be absent from the own JSON
    // fields. A simple optional property conflicts with Object.prototype in TS.
    return `export type ${name} = {\n${ordinary.map(column => '  ' + property(column, optional(column))).join('\n')}\n}`
      + inherited.map(column => ` & ({} | { ${property(column, false)} })`).join('') + ';';
  };
  const text = [
    '// Generated from the authorized Carbon table schema. Do not edit.',
    '// Integer and decimal values use exact strings; timestamps and UUIDs use strings.',
    '// Runtime validation, constraints and row policies remain authoritative.',
    '// Insert fields with defaults or nullable columns may be omitted. Updates must be nonempty.',
    `export const carbonTable = ${JSON.stringify({ id: table.id, name: definition.name, revision: table.revision })} as const;`,
    'export type CarbonJson = null | boolean | number | string | CarbonJson[] | { [key: string]: CarbonJson };',
    'export interface CarbonRowValues {', definition.columns.map(column => '  ' + property(column, false)).join('\n'), '}',
    inputType('CarbonInsert', false), inputType('CarbonUpdate', true),
    'export interface CarbonRow<Columns extends keyof CarbonRowValues = keyof CarbonRowValues> {',
    '  readonly id: string;', '  readonly revision: string;', '  readonly values: Pick<CarbonRowValues, Columns>;', '}', '',
  ].join('\n');
  return parseComponent('DataGeneratedTypes', { tableId: table.id, revision: table.revision, language: 'typescript',
    filename: `${definition.name}-${table.revision}.ts`, contentType: 'text/plain', text });
}
