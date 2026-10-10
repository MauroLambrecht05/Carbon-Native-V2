import { createHash } from 'node:crypto';
import { PlatformFault, type DataConstraint } from '@carbon/contracts/platform';
import { identifier, pgTypes, sameConstraintRule, type NativeDefinition } from '../domain/NativeTable.ts';

function nativeName(tableId: string, id: string) { return 'cc_' + createHash('sha256').update(tableId.toLowerCase() + ':' + id.toLowerCase()).digest('hex').slice(0, 48); }
function literal(value: unknown) { return "E'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'"; }
async function signature(tx: Bun.TransactionSQL, target: string, tableId: string, constraint: DataConstraint): Promise<string> {
  const name = nativeName(tableId, constraint.id);
  const rows = constraint.kind === 'index'
    ? await tx`SELECT concat(i.indisvalid, ':', i.indisready, ':', pg_get_indexdef(i.indexrelid, 0, false)) AS signature
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = ${target}::regclass AND c.relname = ${name}
          AND NOT i.indisunique AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`
    : await tx`SELECT concat(c.contype, ':', c.convalidated, ':', c.condeferrable, ':', pg_get_constraintdef(c.oid, false)) AS signature
        FROM pg_constraint c WHERE c.conrelid = ${target}::regclass AND c.conname = ${name} AND c.contype = ${constraint.kind === 'unique' ? 'u' : 'c'}::"char"`;
  if (rows.length !== 1) throw new PlatformFault('conflict', 'Managed native constraint requires review');
  return rows[0].signature;
}

export async function assertManagedConstraints(tx: Bun.TransactionSQL, target: string, tableId: string, definition: NativeDefinition) {
  const constraints = definition.constraints ?? [];
  const records = await tx`SELECT constraint_id FROM public.canonical_data_constraints WHERE table_id = ${tableId} FOR SHARE`;
  if (records.length !== constraints.length) throw new PlatformFault('conflict', 'Managed constraint catalog requires review');
  for (const constraint of constraints) {
    const native = await signature(tx, target, tableId, constraint);
    const matches = await tx`SELECT constraint_id FROM public.canonical_data_constraints WHERE table_id = ${tableId} AND constraint_id = ${constraint.id}
      AND descriptor = ${JSON.stringify(constraint)}::text::jsonb AND native_signature = ${native}`;
    if (matches.length !== 1) throw new PlatformFault('conflict', 'Managed constraint definition changed outside the catalog');
  }
}

export async function refreshManagedConstraints(tx: Bun.TransactionSQL, target: string, tableId: string, definition: NativeDefinition) {
  for (const constraint of definition.constraints ?? []) {
    const native = await signature(tx, target, tableId, constraint);
    await tx`UPDATE public.canonical_data_constraints SET descriptor = ${JSON.stringify(constraint)}::text::jsonb, native_signature = ${native}
      WHERE table_id = ${tableId} AND constraint_id = ${constraint.id}`;
  }
}

export async function replaceManagedConstraint(tx: Bun.TransactionSQL, schema: string, target: string, tableId: string, definition: NativeDefinition, before?: DataConstraint, after?: DataConstraint) {
  if (before && after && sameConstraintRule(before, after)) {
    await tx`UPDATE public.canonical_data_constraints SET descriptor = ${JSON.stringify(after)}::text::jsonb WHERE table_id = ${tableId} AND constraint_id = ${before.id}`;
    return;
  }
  if (before) {
    const name = identifier(nativeName(tableId, before.id));
    if (before.kind === 'index') await tx.unsafe(`DROP INDEX ${identifier(schema)}.${name} RESTRICT`);
    else await tx.unsafe(`ALTER TABLE ${target} DROP CONSTRAINT ${name} RESTRICT`);
    await tx`DELETE FROM public.canonical_data_constraints WHERE table_id = ${tableId} AND constraint_id = ${before.id}`;
  }
  if (after) {
    const name = identifier(nativeName(tableId, after.id)); const columns = after.columns.map(identifier).join(', ');
    if (after.kind === 'index') await tx.unsafe(`CREATE INDEX ${name} ON ${target} (${columns})`);
    else if (after.kind === 'unique') await tx.unsafe(`ALTER TABLE ${target} ADD CONSTRAINT ${name} UNIQUE (${columns})`);
    else if (after.kind === 'check') {
      const column = definition.columns.find(column => column.name === after.check.column)!;
      const operator = { gte: '>=', lte: '<=', ne: '<>' }[after.check.operator];
      const expression = identifier(column.name) + (column.type === 'text' ? ' COLLATE "C"' : '');
      await tx.unsafe(`ALTER TABLE ${target} ADD CONSTRAINT ${name} CHECK (${expression} ${operator} ${literal(after.check.value)}::${pgTypes[column.type]})`);
    }
    const native = await signature(tx, target, tableId, after);
    await tx`INSERT INTO public.canonical_data_constraints (table_id, constraint_id, descriptor, native_signature)
      VALUES (${tableId}, ${after.id}, ${JSON.stringify(after)}::text::jsonb, ${native})`;
  }
}
