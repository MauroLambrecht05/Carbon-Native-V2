import { HttpAssertionAuthority, PostgresAssertionSecurityStore, ServiceAssertionVerifier, type AssertionTrust } from '@carbon/identity';
import { ApplyServiceLifecycle, PostgresServiceLifecycleRepository, PostgresDatabaseEnvironmentDriver } from '@carbon/catalog';
import { createLifecycleRoutes } from '../infrastructure/http/lifecycle-routes.ts';
import { ExecuteServiceBlobs, ExecuteServiceData, ExecuteServiceImport, PostgresBlobStorage, PostgresNativeTables, type BlobStore } from '@carbon/data';
import { createBlobRoutes, createBlobTransferRoutes } from '../infrastructure/http/blob-routes.ts';
import { createDataRoutes } from '../infrastructure/http/data-routes.ts';
import { createImportRoutes } from '../infrastructure/http/import-routes.ts';

export interface LifecyclePlatformConfig {
  readonly trust: AssertionTrust; readonly authorityOrigin: string;
  /** Blob storage: where bytes are kept, and this service's public origin for transfer addresses. Absent means blobs are not offered. */
  readonly blobs?: { readonly store: BlobStore; readonly origin: string };
}
export function composeLifecyclePlatform(sql: Bun.SQL, config: LifecyclePlatformConfig) {
  const authority = new HttpAssertionAuthority(config.authorityOrigin);
  const security = new PostgresAssertionSecurityStore(sql, (claims, token) => authority.isCurrent(claims, token));
  const verifier = new ServiceAssertionVerifier(config.trust.issuer, 'carbon-database', config.trust.keys, security);
  const lifecycle = createLifecycleRoutes(new ApplyServiceLifecycle(verifier, security, new PostgresServiceLifecycleRepository(sql, new PostgresDatabaseEnvironmentDriver())));
  const data = createDataRoutes(new ExecuteServiceData(verifier, security, new PostgresNativeTables(sql)));
  const imports = createImportRoutes(new ExecuteServiceImport(verifier, security, new PostgresNativeTables(sql)));
  const blobStorage = config.blobs ? new PostgresBlobStorage(sql, config.blobs.store, config.blobs.origin) : undefined;
  const blobs = blobStorage ? createBlobRoutes(new ExecuteServiceBlobs(verifier, security, blobStorage)) : undefined;
  const transfers = blobStorage ? createBlobTransferRoutes(blobStorage) : undefined;
  const unavailable = () => Response.json({ error: { code: 'capability', message: 'Blob storage is not configured' } }, { status: 501 });
  const handler = (request: Request) => {
    const path = new URL(request.url).pathname;
    // Transfer and public addresses are outside the signed internal surface: the address itself is what is checked.
    if (path.startsWith('/storage/v1/transfers/') || path.startsWith('/storage/v1/public/')) return transfers ? transfers(request) : Promise.resolve(unavailable());
    if (path.includes('/blobs/')) return blobs ? blobs(request) : Promise.resolve(unavailable());
    return path.includes('/imports/') ? imports(request) : path.includes('/data/') ? data(request) : lifecycle(request);
  };
  return Object.assign(handler, { blobStorage });
}
