import { HttpAssertionAuthority, PostgresAssertionSecurityStore, ServiceAssertionVerifier, type AssertionTrust } from '@carbon/identity';
import { ApplyServiceLifecycle, ExecuteServiceRegistry, PostgresRegistryNamespaces, PostgresRegistryPackages, PostgresServiceLifecycleRepository, PostgresRegistryEnvironmentDriver, openRegistryTrust,
  type RegistryArchiveStore, type RegistryLimits } from '@carbon/catalog';
import type { RegistryTrustBundle } from '@carbon/contracts/platform';
import { createLifecycleRoutes } from '../infrastructure/http/lifecycle-routes.ts';
import { createRegistryRoutes } from '../infrastructure/http/registry-routes.ts';
import { createDistributionRoutes } from '../infrastructure/http/distribution-routes.ts';

/** What publishing needs. All of it or none: there is no publishing with a generated key or an unsigned bundle. */
export interface PublishingConfig {
  /** A private bucket for quarantined and published archives. */
  readonly store: RegistryArchiveStore;
  /** Where uploaders and installers reach this Registry. */
  readonly origin: string;
  /** The root public key the trust bundle must be signed by. */
  readonly rootPublicKey: string;
  readonly trustBundle: RegistryTrustBundle;
  readonly signingKeyId: string;
  readonly signingSeed: string;
  readonly limits?: RegistryLimits;
}
export interface LifecyclePlatformConfig { readonly trust: AssertionTrust; readonly authorityOrigin: string; readonly publishing?: PublishingConfig }

export function composeLifecyclePlatform(sql: Bun.SQL, config: LifecyclePlatformConfig) {
  const authority = new HttpAssertionAuthority(config.authorityOrigin);
  const security = new PostgresAssertionSecurityStore(sql, (claims, token) => authority.isCurrent(claims, token));
  const verifier = new ServiceAssertionVerifier(config.trust.issuer, 'carbon-registry', config.trust.keys, security);
  const lifecycle = createLifecycleRoutes(new ApplyServiceLifecycle(verifier, security, new PostgresServiceLifecycleRepository(sql, new PostgresRegistryEnvironmentDriver())));
  const publishing = config.publishing;
  // Throws, and so stops start-up, unless the root signed the bundle and the bundle lists this signing key as active.
  const trust = publishing ? openRegistryTrust({ rootPublicKey: publishing.rootPublicKey, bundle: publishing.trustBundle, keyId: publishing.signingKeyId, signingSeed: publishing.signingSeed }) : undefined;
  const packages = publishing && trust ? new PostgresRegistryPackages(sql, publishing.store, trust.signer, new URL(publishing.origin).origin, publishing.limits) : undefined;
  const registry = createRegistryRoutes(new ExecuteServiceRegistry(verifier, security, new PostgresRegistryNamespaces(sql), packages));
  const distribution = packages && trust ? createDistributionRoutes(packages, trust.bundle) : undefined;
  const handler = (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/registry/v1/')) return distribution ? distribution(request) : Promise.resolve(Response.json({ error: { code: 'capability', message: 'Publishing is not configured on this Registry' } }, { status: 501 }));
    return path.includes('/registry/') ? registry(request) : lifecycle(request);
  };
  /** Review is reachable only from inside the service, by an operator tool. No route leads to it. */
  return Object.assign(handler, { review: packages });
}
