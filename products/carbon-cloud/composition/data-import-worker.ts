import { EnvelopeMessageProtector } from '@carbon/identity';
import { PostgresImportJobs, RunImportJobs } from '@carbon/data';
import { importClientFromEnv } from './data-platform.ts';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

if (import.meta.main) {
  if (process.env.CARBON_ACCOUNT_AUTH !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Import worker requires enabled account authentication and DATABASE_URL');
  const transport = importClientFromEnv(); if (!transport) throw new Error('Import worker requires CARBON_DATA_IMPORTS=enabled');
  const keys: unknown = JSON.parse(process.env.CARBON_ACCOUNT_ENCRYPTION_KEYS ?? 'null');
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some(value => typeof value !== 'string')) throw new Error('Invalid account encryption keyring');
  const protector = new EnvelopeMessageProtector(process.env.CARBON_ACCOUNT_ACTIVE_KEY_ID ?? '', keys as Record<string, string>);
  const sql = openDatabase(process.env.DATABASE_URL); const worker = new RunImportJobs(new PostgresImportJobs(sql, protector), transport);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      try { if (await worker.execute()) continue; }
      catch { console.error(JSON.stringify({ event: 'data.import.queue_unavailable' })); }
      await Bun.sleep(1000);
    }
  } finally { await sql.close(); }
}
