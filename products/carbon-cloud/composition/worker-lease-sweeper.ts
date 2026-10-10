import { PostgresWorkerRepository, WorkerLeases } from '@carbon/catalog';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

// Expires worker leases whose window passed and re-offers work a worker held
// and lost. It needs only the Cloud database: it never decrypts a secret.
if (import.meta.main) {
  if (process.env.CARBON_WORKERS !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Worker lease sweeper requires CARBON_WORKERS=enabled and DATABASE_URL');
  const sql = openDatabase(process.env.DATABASE_URL); const leases = new WorkerLeases(new PostgresWorkerRepository(sql));
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      try { await leases.reclaim(crypto.randomUUID()); }
      catch { console.error(JSON.stringify({ event: 'worker.lease.sweep_unavailable' })); }
      await Bun.sleep(5000);
    }
  } finally { await sql.close(); }
}
