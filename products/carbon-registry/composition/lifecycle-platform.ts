import { HttpAssertionAuthority, PostgresAssertionSecurityStore, ServiceAssertionVerifier, type AssertionTrust } from '@carbon/identity';
import { ApplyServiceLifecycle, ExecuteServiceRegistry, PostgresRegistryNamespaces, PostgresServiceLifecycleRepository, PostgresRegistryEnvironmentDriver } from '@carbon/catalog';
import { createLifecycleRoutes } from '../presentation/http/lifecycle-routes.ts';
import { createRegistryRoutes } from '../presentation/http/registry-routes.ts';

export interface LifecyclePlatformConfig { readonly trust: AssertionTrust; readonly authorityOrigin: string }
export function composeLifecyclePlatform(sql: Bun.SQL, config: LifecyclePlatformConfig) {
  const authority = new HttpAssertionAuthority(config.authorityOrigin);
  const security = new PostgresAssertionSecurityStore(sql, (claims, token) => authority.isCurrent(claims, token));
  const verifier = new ServiceAssertionVerifier(config.trust.issuer, 'carbon-registry', config.trust.keys, security);
  const lifecycle = createLifecycleRoutes(new ApplyServiceLifecycle(verifier, security, new PostgresServiceLifecycleRepository(sql, new PostgresRegistryEnvironmentDriver())));
  const registry = createRegistryRoutes(new ExecuteServiceRegistry(verifier, security, new PostgresRegistryNamespaces(sql)));
  return (request: Request) => new URL(request.url).pathname.includes('/registry/') ? registry(request) : lifecycle(request);
}
