import { PostgresWorkerRepository, WorkerLeases } from '@carbon/catalog';
import { BuildOrchestration, FunctionOrchestration, PostgresPlatformBuildRepository, PostgresPlatformFunctionRepository } from '@carbon/orchestration';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

// Expires worker leases whose window passed and re-offers work a worker held
// and lost, then fails builds that have no lease left to run on. It needs only
// the Cloud database: it never decrypts a secret.
if (import.meta.main) {
  if (process.env.CARBON_WORKERS !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Worker lease sweeper requires CARBON_WORKERS=enabled and DATABASE_URL');
  const sql = openDatabase(process.env.DATABASE_URL); const workers = new PostgresWorkerRepository(sql); const leases = new WorkerLeases(workers);
  const builds = new BuildOrchestration(new PostgresPlatformBuildRepository(sql, workers));
  const functions = new FunctionOrchestration(new PostgresPlatformFunctionRepository(sql, workers));
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      // Leases first: a lost worker's build gets its retry before the build is judged stuck.
      // Then functions: executions that can no longer finish are ended, and schedules that are due are fired.
      try { await leases.reclaim(crypto.randomUUID()); await builds.reconcile(crypto.randomUUID()); await functions.reconcile(crypto.randomUUID()); await functions.tick(crypto.randomUUID()); await functions.prune(); }
      catch { console.error(JSON.stringify({ event: 'worker.lease.sweep_unavailable' })); }
      await Bun.sleep(5000);
    }
  } finally { await sql.close(); }
}
