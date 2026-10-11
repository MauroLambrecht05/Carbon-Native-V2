import { PlatformFault, type DataColumn, type DataRow, type DataTableDefinition } from '@carbon/contracts/platform';

export type ExportFormat = 'jsonl' | 'csv';

/** The columns an export carries, in the order they are written: the requested projection, or every column as defined. */
export function exportColumns(definition: DataTableDefinition, selected?: readonly string[]): DataColumn[] {
  if (!selected?.length) return [...definition.columns];
  return selected.map(name => { const column = definition.columns.find(item => item.name === name); if (!column) throw new PlatformFault('validation', 'An export column does not exist'); return column; });
}

// A spreadsheet treats a cell that starts with one of these as a formula. Text cells that do are written with a leading
// apostrophe so opening the file cannot run anything. Only text is guarded: numbers must stay numbers.
const FORMULA = /^[=+\-@\t\r]/;
function cell(column: DataColumn, value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (column.type === 'boolean') text = value ? 'true' : 'false';
  else if (column.type === 'text') text = FORMULA.test(value as string) ? `'${value as string}` : value as string;
  else if (typeof value === 'string') text = value;
  // Arrays and JSON keep their exact value as JSON text.
  else text = JSON.stringify(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Encodes one page of rows. Values are written exactly as the data API returns them: integers and decimals stay the
 * exact strings they are on the wire. `first` adds the CSV header; JSON Lines has none.
 */
export function encodeExportRows(format: ExportFormat, columns: readonly DataColumn[], rows: readonly DataRow[], first: boolean): Uint8Array {
  let text = '';
  if (format === 'jsonl') {
    for (const row of rows) text += JSON.stringify({ id: row.id, values: Object.fromEntries(columns.map(column => [column.name, row.values[column.name] ?? null])) }) + '\n';
  } else {
    if (first) text += ['_id', ...columns.map(column => column.name)].join(',') + '\r\n';
    for (const row of rows) text += [row.id, ...columns.map(column => cell(column, row.values[column.name]))].join(',') + '\r\n';
  }
  return new TextEncoder().encode(text);
}
