import { ServiceAssertionVerifier, type AssertionTrust } from '@carbon/identity';
import { CheckServiceAuthority, PostgresServiceAuthority } from '@carbon/catalog';
import { createAuthorityRoutes } from '../infrastructure/http/authority-routes.ts';

export function composeServiceAuthority(sql: Bun.SQL, trust: AssertionTrust) {
  // Introspection checks cryptography and live state; replay is owned by each receiving service.
  const inspectionOnly = { isCurrent: async () => false, consume: async () => false };
  return createAuthorityRoutes(new CheckServiceAuthority(['carbon-database', 'carbon-registry'].map(audience =>
    new ServiceAssertionVerifier(trust.issuer, audience as 'carbon-database' | 'carbon-registry', trust.keys, inspectionOnly)), new PostgresServiceAuthority(sql)));
}
