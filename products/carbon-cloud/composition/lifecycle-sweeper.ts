import { CatalogLifecycle, PostgresCatalogRepository } from '@carbon/catalog';
import { OrganizationLifecycle, PostgresAuditLog } from '@carbon/identity';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

// Makes deletions final once their recovery window has passed: environments
// and projects first, then organizations. It marks rows deleted; it does not
// destroy owning-service data.
if (import.meta.main) {
  if (process.env.CARBON_ACCOUNT_AUTH !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Lifecycle sweeper requires enabled account authentication and DATABASE_URL');
  const sql = openDatabase(process.env.DATABASE_URL);
  const catalog = new CatalogLifecycle(new PostgresCatalogRepository(sql)); const organizations = new OrganizationLifecycle(new PostgresAuditLog(sql));
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      try { await catalog.finalizeDeletions(crypto.randomUUID()); await organizations.finalizeDeletions(crypto.randomUUID()); }
      catch { console.error(JSON.stringify({ event: 'lifecycle.sweep_unavailable' })); }
      await Bun.sleep(60_000);
    }
  } finally { await sql.close(); }
}
