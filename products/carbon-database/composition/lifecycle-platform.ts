import { HttpAssertionAuthority, PostgresAssertionSecurityStore, ServiceAssertionVerifier, type AssertionTrust } from '@carbon/identity';
import { ApplyServiceLifecycle, PostgresServiceLifecycleRepository, PostgresDatabaseEnvironmentDriver } from '@carbon/catalog';
import { createLifecycleRoutes } from '../infrastructure/http/lifecycle-routes.ts';
import { ExecuteServiceData, ExecuteServiceImport, PostgresNativeTables } from '@carbon/data';
import { createDataRoutes } from '../infrastructure/http/data-routes.ts';
import { createImportRoutes } from '../infrastructure/http/import-routes.ts';

export interface LifecyclePlatformConfig { readonly trust: AssertionTrust; readonly authorityOrigin: string }
export function composeLifecyclePlatform(sql: Bun.SQL, config: LifecyclePlatformConfig) {
  const authority = new HttpAssertionAuthority(config.authorityOrigin);
  const security = new PostgresAssertionSecurityStore(sql, (claims, token) => authority.isCurrent(claims, token));
  const verifier = new ServiceAssertionVerifier(config.trust.issuer, 'carbon-database', config.trust.keys, security);
  const lifecycle = createLifecycleRoutes(new ApplyServiceLifecycle(verifier, security, new PostgresServiceLifecycleRepository(sql, new PostgresDatabaseEnvironmentDriver())));
  const data = createDataRoutes(new ExecuteServiceData(verifier, security, new PostgresNativeTables(sql)));
  const imports = createImportRoutes(new ExecuteServiceImport(verifier, security, new PostgresNativeTables(sql)));
  return (request: Request) => { const path = new URL(request.url).pathname; return path.includes('/imports/') ? imports(request) : path.includes('/data/') ? data(request) : lifecycle(request); };
}
