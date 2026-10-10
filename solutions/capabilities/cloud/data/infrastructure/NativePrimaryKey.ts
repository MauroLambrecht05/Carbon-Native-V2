import { PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { identifier } from '../domain/NativeTable.ts';

export function nativePrimaryKeyName(tableId: string): string {
  parseComponent('Id', tableId); return 'carbon_pk_' + tableId.replaceAll('-', '').toLowerCase();
}

/** The public user key is UNIQUE + NOT NULL; the internal UUID remains the physical primary key. */
export async function replaceNativePrimaryKey(tx: Bun.TransactionSQL, target: string, tableId: string, before: string | undefined, after: string | undefined) {
  const name = nativePrimaryKeyName(tableId);
  const reserved = await tx`SELECT conname FROM pg_constraint WHERE conrelid = ${target}::regclass AND conname = ${name}`;
  let previous: string | undefined;
  if (before) {
    const matches = await tx`SELECT c.conname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = ${before}
      JOIN pg_index i ON i.indexrelid = c.conindid
      WHERE c.conrelid = ${target}::regclass AND c.contype = 'u' AND c.conkey = ARRAY[a.attnum]::smallint[]
        AND c.convalidated AND NOT c.condeferrable AND a.attnotnull AND i.indisvalid AND i.indisunique`;
    // Older canonical tables used PostgreSQL-generated names. Adopt only one exact matching key.
    if (matches.length !== 1 || (reserved.length && matches[0].conname !== name)) throw new PlatformFault('conflict', 'Native user-key constraint requires review');
    previous = matches[0].conname;
  } else if (reserved.length) throw new PlatformFault('conflict', 'Unexpected native user-key constraint');
  if (before === after) return;
  if (previous) await tx.unsafe(`ALTER TABLE ${target} DROP CONSTRAINT ${identifier(previous)} RESTRICT`);
  if (after) {
    await tx.unsafe(`ALTER TABLE ${target} ALTER COLUMN ${identifier(after)} SET NOT NULL`);
    await tx.unsafe(`ALTER TABLE ${target} ADD CONSTRAINT ${identifier(name)} UNIQUE (${identifier(after)})`);
  }
}
