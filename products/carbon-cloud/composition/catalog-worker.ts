import { HttpEnvironmentProvisioner, PostgresProvisioningRepository, ProvisionEnvironment, type EnvironmentProvisioner } from '@carbon/catalog';
import type { ServiceOwner } from '@carbon/contracts/platform';
import { serviceAssertionIssuerFromEnv } from './service-assertion-signing.ts';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

export function catalogProvisionersFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ServiceOwner, EnvironmentProvisioner>> {
  const configured = { database: env.CARBON_PROVISIONING_DATABASE_ORIGIN, registry: env.CARBON_PROVISIONING_REGISTRY_ORIGIN };
  if (!configured.database && !configured.registry) return {};
  const issuer = serviceAssertionIssuerFromEnv(env);
  const providers: Partial<Record<ServiceOwner, EnvironmentProvisioner>> = {};
  for (const owner of ['database', 'registry'] as const) if (configured[owner]) providers[owner] = new HttpEnvironmentProvisioner(owner, configured[owner], issuer);
  return providers;
}

if (import.meta.main) {
  if (process.env.CARBON_ACCOUNT_AUTH !== 'enabled' || !process.env.DATABASE_URL) throw new Error('Catalog worker requires enabled account authentication and DATABASE_URL');
  const providers = catalogProvisionersFromEnv(); const sql = openDatabase(process.env.DATABASE_URL);
  const worker = new ProvisionEnvironment(new PostgresProvisioningRepository(sql), providers);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      try { if (await worker.execute()) continue; }
      catch { console.error(JSON.stringify({ event: 'catalog.provisioning.queue_unavailable' })); }
      await Bun.sleep(1000);
    }
  } finally { await sql.close(); }
}
