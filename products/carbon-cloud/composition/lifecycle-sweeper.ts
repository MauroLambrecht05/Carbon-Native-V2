import { CatalogLifecycle, EraseEnvironments, HttpServiceEraser, PostgresCatalogRepository, PostgresErasureRepository, type ServiceEraser } from '@carbon/catalog';
import type { ServiceOwner } from '@carbon/contracts/platform';
import { serviceAssertionIssuerFromEnv } from './service-assertion-signing.ts';
import { OrganizationLifecycle, PostgresAuditLog } from '@carbon/identity';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

// Makes deletions final once their recovery window has passed: environments
// and projects first, then organizations. Then it carries each final deletion
// to the owning services, which destroy what they hold for the environment.
//
// Erasure needs the owning services' origins and Cloud's assertion signing
// key, the same settings the catalog worker uses. Without them deletions are
// still made final and their erasures stay on record, undelivered, and this
// says so when it starts.
export function erasersFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ServiceOwner, ServiceEraser>> {
  const configured = { database: env.CARBON_PROVISIONING_DATABASE_ORIGIN, registry: env.CARBON_PROVISIONING_REGISTRY_ORIGIN };
  if (!configured.database && !configured.registry) return {};
  const issuer = serviceAssertionIssuerFromEnv(env); const erasers: Partial<Record<ServiceOwner, ServiceEraser>> = {};
  for (const owner of ['database', 'registry'] as const) if (configured[owner]) erasers[owner] = new HttpServiceEraser(owner, configured[owner], issuer);
  return erasers;
}

if (import.meta.main) {
  if (process.env.CARBON_ACCOUNT_AUTH !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Lifecycle sweeper requires enabled account authentication and DATABASE_URL');
  const sql = openDatabase(process.env.DATABASE_URL);
  const catalog = new CatalogLifecycle(new PostgresCatalogRepository(sql)); const organizations = new OrganizationLifecycle(new PostgresAuditLog(sql));
  const erasers = erasersFromEnv(); const erasure = new EraseEnvironments(new PostgresErasureRepository(sql), erasers);
  for (const owner of ['database', 'registry'] as const) if (!erasers[owner]) console.error(JSON.stringify({ event: 'lifecycle.erasure_not_configured', owner }));
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      try { await catalog.finalizeDeletions(crypto.randomUUID()); await organizations.finalizeDeletions(crypto.randomUUID()); await erasure.execute(crypto.randomUUID()); }
      catch { console.error(JSON.stringify({ event: 'lifecycle.sweep_unavailable' })); }
      await Bun.sleep(60_000);
    }
  } finally { await sql.close(); }
}
