import { PlatformFault, parseComponent, type DataImportInput, type DataImportPreview, type DataImportRowError, type DataTable } from '@carbon/contracts/platform';
import { validateDefinition, validateValue, type NativeColumn } from './NativeTable.ts';
import { parseImportCsv, parseImportJson, type CsvCell } from './ImportSource.ts';

const fail = (message: string): never => { throw new PlatformFault('validation', message); };
function sourceName(name: string) { return name.length > 0 && name.length <= 128 && !/[\u0000-\u001f]/.test(name); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function csvValue(cell: CsvCell, column: NativeColumn): unknown {
  if (!cell.quoted && cell.text === '\\N') return null;
  if (column.type === 'boolean') {
    if (cell.text === 'true') return true; if (cell.text === 'false') return false;
    return fail('Invalid CSV boolean');
  }
  if (['json', 'jsonb', 'text[]', 'integer[]'].includes(column.type)) return parseImportJson(cell.text);
  return cell.text;
}

export type PreparedImportRow = { row: number; values: Record<string, unknown>; error?: never } | { row: number; error: DataImportRowError; values?: never };

/** Shared bounded source preparation; native execution still validates its effects. */
export function prepareImport(tableInput: DataTable, inputValue: DataImportInput): { table: DataTable; rows: PreparedImportRow[] } {
  const table = parseComponent('DataTable', tableInput); const definition = validateDefinition(table.definition);
  const input = parseComponent('DataImportInput', inputValue);
  if (Buffer.byteLength(input.text) > 262144) fail('Import source exceeds 256 KiB');
  if (input.conflict !== 'error' && !definition.primaryKey) fail('Skip or update requires a user primary key');
  let rows: unknown[]; const sources = new Set<string>();
  if (input.format === 'json') {
    const parsed = parseImportJson(input.text);
    if (!Array.isArray(parsed)) fail('JSON import must be an array of row objects');
    rows = parsed as unknown[];
    for (const row of rows) if (object(row)) for (const key of Object.keys(row)) sources.add(key);
  } else {
    const records = parseImportCsv(input.text); const headers = records.shift()?.map(cell => cell.text) ?? [];
    if (!headers.length || headers.some(name => !sourceName(name)) || new Set(headers).size !== headers.length) fail('CSV requires distinct nonempty headers');
    for (const name of headers) sources.add(name);
    rows = records.map(record => record.length === headers.length ? Object.fromEntries(headers.map((name, index) => [name, record[index]!])) : null);
  }
  if (rows.length > 1000 || sources.size > 100 || [...sources].some(name => !sourceName(name))) fail('Import source exceeds row, column or header limits');
  if (Object.keys(input.mapping).some(name => !sources.has(name))) fail('Mapping refers to an unknown source column');
  const targets = new Set<string>();
  const targetFor = (name: string) => Object.hasOwn(input.mapping, name) ? input.mapping[name]! : name;
  for (const source of sources) {
    const target = targetFor(source); if (!target) continue;
    if (targets.has(target)) fail('Multiple source columns map to one target'); targets.add(target);
  }
  const prepared: PreparedImportRow[] = [];
  rows.forEach((row, index) => {
    let error: Omit<DataImportRowError, 'row'> | undefined; const values: Record<string, unknown> = {};
    if (!object(row)) error = { code: 'row_shape', message: 'Import row must match the source column shape' };
    else {
      for (const [source, raw] of Object.entries(row)) {
        const name = targetFor(source); if (!name) continue;
        const column = definition.columns.find(column => column.name === name);
        if (!column) { error = { code: 'unknown_column', message: 'Source includes an unknown target column' }; break; }
        try {
          const value = input.format === 'csv' ? csvValue(raw as CsvCell, column) : raw;
          validateValue(column, value); Object.defineProperty(values, name, { value, enumerable: true, writable: true, configurable: true });
        } catch { error = { code: 'invalid_value', column: name, message: 'Value does not match the declared column type or nullability' }; break; }
      }
      if (!error) for (const column of definition.columns) {
        if (!column.nullable && column.default === undefined && !Object.hasOwn(values, column.name)) {
          error = { code: 'missing_column', column: column.name, message: 'A required column is missing' }; break;
        }
      }
      if (!error && Buffer.byteLength(JSON.stringify(values)) > 65536) error = { code: 'row_too_large', message: 'Mapped row exceeds 64 KiB' };
    }
    if (error) prepared.push({ row: index + 1, error: { row: index + 1, ...error } });
    else prepared.push({ row: index + 1, values });
  });
  return { table, rows: prepared };
}

/** Structural review never reads table rows, evaluates policies or simulates a commit. */
export function previewImport(tableInput: DataTable, inputValue: DataImportInput): DataImportPreview {
  const { table, rows } = prepareImport(tableInput, inputValue);
  const samples: DataImportPreview['samples'][number][] = []; const errors: DataImportRowError[] = []; let invalid = 0;
  for (const row of rows) {
    if (row.error) { invalid++; if (errors.length < 100) errors.push(row.error); }
    else if (samples.length < 20) samples.push({ row: row.row, values: row.values });
  }
  return parseComponent('DataImportPreview', { tableId: table.id, revision: table.revision, validation: 'structure', total: rows.length,
    valid: rows.length - invalid, invalid, samples, errors, errorsTruncated: invalid > errors.length });
}
