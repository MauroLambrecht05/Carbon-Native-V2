import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type DataImportExecution, type DataImportExecutionResult, type DataImportFailure, type DataTable } from '@carbon/contracts/platform';
import { prepareImport } from '../domain/ImportPreview.ts';
import { identifier, pgTypes, type NativeColumn } from '../domain/NativeTable.ts';

function nativeFailure(error: unknown, row: number): DataImportFailure | undefined {
  const errno = (error as { errno?: string })?.errno;
  if (errno === '42501') return { row, code: 'policy_denied', message: 'Row policy does not permit this operation' };
  if (['23505', '23503', '23514'].includes(errno ?? '')) return { row, code: 'constraint_violation', message: 'Row conflicts with a native constraint' };
  if (['23502', '22P02', '22003', '22001', '22007', '22008', '42804'].includes(errno ?? '')) return { row, code: 'invalid_value', message: 'Row cannot be stored using the declared column types' };
  return undefined;
}

/** Runs under the existing restricted native row role and enclosing receipt transaction. */
export async function applyNativeImport(tx: Bun.TransactionSQL, target: string, table: DataTable, command: DataImportExecution,
  parameters: (input: Record<string, unknown>) => readonly { column: NativeColumn; value: unknown }[]): Promise<DataImportExecutionResult> {
  if (table.revision !== command.revision) throw new PlatformFault('conflict', 'Table revision changed');
  if (command.input.conflict === 'update' && command.confirmation !== table.definition.name) throw new PlatformFault('validation', 'Confirm the current table name for an updating import');
  const { rows } = prepareImport(table, command.input);
  if (!rows.length) throw new PlatformFault('validation', 'Import is empty');
  const result = { commandId: command.commandId, tableId: table.id, revision: table.revision, total: rows.length,
    inserted: 0, updated: 0, skipped: 0, failed: 0, errors: [] as DataImportFailure[], errorsTruncated: false };
  const deadline = performance.now() + 15000;
  const timely = () => { if (performance.now() > deadline) throw new PlatformFault('unavailable', 'Import execution timed out'); };
  const reject = (error: DataImportFailure) => {
    if (command.input.atomic) throw new PlatformFault(error.code === 'policy_denied' ? 'forbidden' : error.code === 'constraint_violation' ? 'conflict' : 'validation',
      'Import row could not be applied', { row: String(error.row), reason: error.code });
    result.failed++; if (result.errors.length < 100) result.errors.push(error);
  };
  for (const row of rows) {
    timely(); if (row.error) { reject(row.error); continue; }
    const values = parameters(row.values); const proposedId = randomUUID();
    const columns = ['_carbon_id', ...values.map(item => identifier(item.column.name))].join(', ');
    const bindings = ['$1::uuid', ...values.map((item, index) => `$${index + 2}${['json', 'jsonb'].includes(item.column.type) ? '::text' : ''}::${pgTypes[item.column.type]}`)].join(', ');
    let conflict = '';
    if (command.input.conflict !== 'error') {
      const key = identifier(table.definition.primaryKey!);
      conflict = ` ON CONFLICT (${key}) DO NOTHING`;
      if (command.input.conflict === 'update') {
        const set = [...values.filter(item => item.column.name !== table.definition.primaryKey).map(item => `${identifier(item.column.name)} = EXCLUDED.${identifier(item.column.name)}`),
          '_carbon_revision = existing._carbon_revision + 1'].join(', ');
        conflict = ` ON CONFLICT (${key}) DO UPDATE SET ${set}`;
      }
    }
    if (!command.input.atomic) await tx.unsafe('SAVEPOINT carbon_import_row');
    try {
      const applied = await tx.unsafe(`INSERT INTO ${target} AS existing (${columns}) VALUES (${bindings})${conflict} RETURNING _carbon_id::text`, [proposedId, ...values.map(item => item.value)]);
      timely();
      if (!applied.length && command.input.conflict === 'skip') result.skipped++;
      else if (applied.length !== 1) throw new PlatformFault('conflict', 'Import did not apply a row');
      else if (command.input.conflict === 'update' && applied[0]._carbon_id !== proposedId) result.updated++;
      else result.inserted++;
    } catch (error) {
      if (!command.input.atomic) await tx.unsafe('ROLLBACK TO SAVEPOINT carbon_import_row');
      const failure = nativeFailure(error, row.row); if (!failure) throw error;
      reject(failure);
    }
    if (!command.input.atomic) await tx.unsafe('RELEASE SAVEPOINT carbon_import_row');
  }
  timely(); result.errorsTruncated = result.failed > result.errors.length;
  return parseComponent('DataImportExecutionResult', result);
}
