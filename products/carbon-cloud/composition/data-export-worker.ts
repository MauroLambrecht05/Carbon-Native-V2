import { PostgresExportJobs, RunExportJobs } from '@carbon/data';
import { dataClientFromEnv, exportStoreFromEnv } from './data-platform.ts';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

// Runs queued table exports and removes expired ones. It needs the Cloud
// database, the signing key for Database assertions, and the private export bucket.
if (import.meta.main) {
  if (process.env.CARBON_ACCOUNT_AUTH !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Export worker requires enabled account authentication and DATABASE_URL');
  const store = exportStoreFromEnv(); const transport = dataClientFromEnv();
  if (!store || !transport) throw new Error('Export worker requires CARBON_DATA_EXPORTS=enabled and CARBON_DATA_DATABASE_ORIGIN');
  const sql = openDatabase(process.env.DATABASE_URL); const worker = new RunExportJobs(new PostgresExportJobs(sql), transport, store);
  let stopping = false; let swept = 0;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      try {
        if (Date.now() - swept > 60_000) { await worker.sweep(); swept = Date.now(); }
        if (await worker.execute()) continue;
      } catch { console.error(JSON.stringify({ event: 'data.export.queue_unavailable' })); }
      await Bun.sleep(1000);
    }
  } finally { await sql.close(); }
}
