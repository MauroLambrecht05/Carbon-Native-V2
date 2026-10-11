import { HttpBlobClient, HttpDataClient, HttpEngineClient, HttpImportClient, S3ExportStore } from '@carbon/data';
import { HttpRegistryClient } from '@carbon/catalog';
import { serviceAssertionIssuerFromEnv } from './service-assertion-signing.ts';

export function dataClientFromEnv(env: NodeJS.ProcessEnv = process.env): HttpDataClient | undefined {
  if (!env.CARBON_DATA_DATABASE_ORIGIN) return undefined;
  return new HttpDataClient(env.CARBON_DATA_DATABASE_ORIGIN, serviceAssertionIssuerFromEnv(env));
}

export function importClientFromEnv(env: NodeJS.ProcessEnv = process.env): HttpImportClient | undefined {
  if (!env.CARBON_DATA_IMPORTS || env.CARBON_DATA_IMPORTS === 'disabled') return undefined;
  if (env.CARBON_DATA_IMPORTS !== 'enabled') throw new Error('CARBON_DATA_IMPORTS must be enabled or disabled');
  if (!env.CARBON_DATA_DATABASE_ORIGIN) throw new Error('Durable imports require CARBON_DATA_DATABASE_ORIGIN');
  return new HttpImportClient(env.CARBON_DATA_DATABASE_ORIGIN, serviceAssertionIssuerFromEnv(env));
}

/** Private storage for table exports. Its bucket must not be the public artifact bucket. */
export function exportStoreFromEnv(env: NodeJS.ProcessEnv = process.env): S3ExportStore | undefined {
  if (!env.CARBON_DATA_EXPORTS || env.CARBON_DATA_EXPORTS === 'disabled') return undefined;
  if (env.CARBON_DATA_EXPORTS !== 'enabled') throw new Error('CARBON_DATA_EXPORTS must be enabled or disabled');
  if (!env.CARBON_DATA_DATABASE_ORIGIN) throw new Error('Exports require CARBON_DATA_DATABASE_ORIGIN');
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`Exports require ${name}`); return value; };
  const bucket = required('CARBON_EXPORT_BUCKET');
  if (bucket === env.OBJECT_STORE_BUCKET) throw new Error('CARBON_EXPORT_BUCKET must be a private bucket, separate from OBJECT_STORE_BUCKET');
  return new S3ExportStore({ endpoint: required('OBJECT_STORE_ENDPOINT'), bucket, accessKeyId: required('OBJECT_STORE_ACCESS_KEY_ID'), secretAccessKey: required('OBJECT_STORE_SECRET_ACCESS_KEY') });
}

/** Cloud's transport for blob commands. Blobs are offered when the Database origin is configured and CARBON_BLOBS is enabled. */
export function blobClientFromEnv(env: NodeJS.ProcessEnv = process.env): HttpBlobClient | undefined {
  if (!env.CARBON_BLOBS || env.CARBON_BLOBS === 'disabled') return undefined;
  if (env.CARBON_BLOBS !== 'enabled') throw new Error('CARBON_BLOBS must be enabled or disabled');
  if (!env.CARBON_DATA_DATABASE_ORIGIN) throw new Error('Blob storage requires CARBON_DATA_DATABASE_ORIGIN');
  return new HttpBlobClient(env.CARBON_DATA_DATABASE_ORIGIN, serviceAssertionIssuerFromEnv(env));
}

/** Cloud's transports for vector and graph commands, offered together when CARBON_DATA_ENGINES is enabled. */
export function engineClientsFromEnv(env: NodeJS.ProcessEnv = process.env): { vectors: HttpEngineClient; graph: HttpEngineClient } | undefined {
  if (!env.CARBON_DATA_ENGINES || env.CARBON_DATA_ENGINES === 'disabled') return undefined;
  if (env.CARBON_DATA_ENGINES !== 'enabled') throw new Error('CARBON_DATA_ENGINES must be enabled or disabled');
  if (!env.CARBON_DATA_DATABASE_ORIGIN) throw new Error('Vector and graph data require CARBON_DATA_DATABASE_ORIGIN');
  const issuer = serviceAssertionIssuerFromEnv(env);
  return { vectors: new HttpEngineClient('vectors', env.CARBON_DATA_DATABASE_ORIGIN, issuer), graph: new HttpEngineClient('graph', env.CARBON_DATA_DATABASE_ORIGIN, issuer) };
}

/** Cloud's transport for Registry commands, offered when CARBON_REGISTRY_PUBLISHING is enabled. */
export function registryClientFromEnv(env: NodeJS.ProcessEnv = process.env): HttpRegistryClient | undefined {
  if (!env.CARBON_REGISTRY_PUBLISHING || env.CARBON_REGISTRY_PUBLISHING === 'disabled') return undefined;
  if (env.CARBON_REGISTRY_PUBLISHING !== 'enabled') throw new Error('CARBON_REGISTRY_PUBLISHING must be enabled or disabled');
  if (!env.CARBON_REGISTRY_ORIGIN) throw new Error('Registry publishing requires CARBON_REGISTRY_ORIGIN');
  return new HttpRegistryClient(env.CARBON_REGISTRY_ORIGIN, serviceAssertionIssuerFromEnv(env));
}
