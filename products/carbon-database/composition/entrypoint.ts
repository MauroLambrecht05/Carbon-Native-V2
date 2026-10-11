// Composition root for carbon-database: opens the real Postgres
// connection, runs migrations, builds the real S3-compatible object-
// storage client, wires up an HttpIdentityClient pointed at carbon-cloud
// (real SSO — this product keeps no organizations/api_tokens of its own,
// see HttpIdentityClient's own header comment), constructs every real
// engine, attaches HTTP routes, and launches the server.

import { HttpIdentityClient, assertionTrustFromEnv } from "@carbon/identity";
import { PostgresNativeTables, S3BlobStore } from '@carbon/data';
import { composeLifecyclePlatform, type LifecyclePlatformConfig } from './lifecycle-platform.ts';
import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";
import { DatabaseEngine } from "../infrastructure/services/DatabaseEngine.ts";
import { VectorEngine } from "../infrastructure/services/VectorEngine.ts";
import { GraphEngine } from "../infrastructure/services/GraphEngine.ts";
import { EdgeFunctionsEngine } from "../infrastructure/services/EdgeFunctionsEngine.ts";
import { StorageEngine } from "../infrastructure/services/StorageEngine.ts";
import { RealtimeEngine } from "../infrastructure/services/RealtimeEngine.ts";
import { RlsPolicyEngine } from "../infrastructure/services/RlsPolicyEngine.ts";
import { MigrationEngine } from "../infrastructure/persistence/MigrationEngine.ts";
import { SnapshotEngine } from "../infrastructure/persistence/SnapshotEngine.ts";
import { buildDatabaseRoutes } from "../infrastructure/http/routes.ts";
import { startDatabaseServer } from "../infrastructure/http/server.ts";
import { composeOperations } from "./operations.ts";

export interface CarbonDatabaseConfig {
  readonly internalPlatform?: LifecyclePlatformConfig;
  readonly port: number;
  readonly databaseUrl: string;
  readonly controlPlaneUrl: string;
  readonly objectStore: {
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly bucket: string;
  };
}

/**
 * Blob storage needs a private bucket of its own and this service's public origin, which transfer addresses are built
 * from. The bucket must not be the one the legacy storage engine serves public files from.
 */
function blobsFromEnv(env: NodeJS.ProcessEnv, required: (name: string) => string): LifecyclePlatformConfig['blobs'] {
  if (!env.CARBON_BLOBS || env.CARBON_BLOBS === 'disabled') return undefined;
  if (env.CARBON_BLOBS !== 'enabled') throw new Error('CARBON_BLOBS must be enabled or disabled');
  const bucket = required('CARBON_BLOB_BUCKET');
  if (bucket === env.OBJECT_STORE_BUCKET) throw new Error('CARBON_BLOB_BUCKET must be a private bucket, separate from OBJECT_STORE_BUCKET');
  const origin = new URL(required('CARBON_DATABASE_PUBLIC_ORIGIN'));
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username) throw new Error('CARBON_DATABASE_PUBLIC_ORIGIN must be a bare origin');
  return { origin: origin.origin, store: new S3BlobStore({ endpoint: required('OBJECT_STORE_ENDPOINT'), bucket, accessKeyId: required('OBJECT_STORE_ACCESS_KEY_ID'), secretAccessKey: required('OBJECT_STORE_SECRET_ACCESS_KEY') }) };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonDatabaseConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  const trust = assertionTrustFromEnv(env);
  return {
    internalPlatform: trust ? { trust, authorityOrigin: required('CARBON_AUTHORITY_ORIGIN'), blobs: blobsFromEnv(env, required) } : undefined,
    port: Number(env.PORT ?? 54321),
    databaseUrl: required("DATABASE_URL"),
    controlPlaneUrl: required("CONTROL_PLANE_URL"),
    objectStore: {
      endpoint: required("OBJECT_STORE_ENDPOINT"),
      accessKeyId: required("OBJECT_STORE_ACCESS_KEY_ID"),
      secretAccessKey: required("OBJECT_STORE_SECRET_ACCESS_KEY"),
      bucket: required("OBJECT_STORE_BUCKET"),
    },
  };
}

export async function buildDatabaseSystem(config: CarbonDatabaseConfig) {
  const sql = openDatabase(config.databaseUrl);
  // By default a service brings its own schema up to date when it starts. A deployment that runs migrations as a release step
  // turns this off; the service then starts against the schema it finds, and reports not ready until it is the right one.
  if (process.env.CARBON_MIGRATE_ON_START !== "disabled") await migrate(sql);

  const s3 = new Bun.S3Client({
    endpoint: config.objectStore.endpoint,
    accessKeyId: config.objectStore.accessKeyId,
    secretAccessKey: config.objectStore.secretAccessKey,
    bucket: config.objectStore.bucket,
  });

  const verifyToken = new HttpIdentityClient(config.controlPlaneUrl);
  const realtime = new RealtimeEngine();
  const rls = new RlsPolicyEngine(sql);
  await rls.loadAll();

  const databaseEngine = new DatabaseEngine(sql, realtime, rls);
  const vectorEngine = new VectorEngine(sql);
  const graphEngine = new GraphEngine(sql);
  const edgeFunctionsEngine = new EdgeFunctionsEngine(sql);
  const storageEngine = new StorageEngine(sql, s3);
  const migrationEngine = new MigrationEngine(sql, databaseEngine);
  const snapshotEngine = new SnapshotEngine(databaseEngine, vectorEngine, graphEngine, edgeFunctionsEngine, storageEngine);

  const deps = {
    nativeTables: new PostgresNativeTables(sql),
    sql,
    controlPlaneUrl: config.controlPlaneUrl,
    verifyToken,
    databaseEngine,
    vectorEngine,
    graphEngine,
    edgeFunctionsEngine,
    storageEngine,
    rlsEngine: rls,
    migrationEngine,
    snapshotEngine,
  };

  const legacyHandler = buildDatabaseRoutes(deps);
  const lifecycle = config.internalPlatform ? composeLifecyclePlatform(sql, config.internalPlatform) : undefined;
  // Canonical blob transfer and public addresses are served by the platform handler; every other /storage path is the legacy engine's.
  const canonical = (path: string) => path.startsWith('/internal/platform/v1/') || path.startsWith('/storage/v1/transfers/') || path.startsWith('/storage/v1/public/');
  const handler = (request: Request) => canonical(new URL(request.url).pathname)
    ? lifecycle ? lifecycle(request) : Promise.resolve(Response.json({ error: { code: 'capability', message: 'Internal platform is not configured', requestId: crypto.randomUUID() } }, { status: 501, headers: { 'cache-control': 'no-store' } }))
    : legacyHandler(request);
  return { sql, deps, handler, realtime, blobStorage: lifecycle?.blobStorage, pruneChanges: lifecycle?.pruneChanges };
}

export async function startDatabase(config: CarbonDatabaseConfig = configFromEnv()) {
  const { sql, handler, realtime, deps, blobStorage, pruneChanges } = await buildDatabaseSystem(config);
  const operations = composeOperations(sql);
  const observedHandler = operations.observe(async (request: Request) => (await operations.routes(request)) ?? handler(request));
  const server = startDatabaseServer({ port: config.port, handler: observedHandler, realtime });
  // The change feed keeps three days of events; older ones are removed hourly.
  if (pruneChanges) setInterval(() => { pruneChanges().catch(() => console.error(JSON.stringify({ event: 'data.changes.prune_unavailable' }))); }, 3_600_000).unref();
  // Blob cleanup: lapsed transfer addresses, abandoned uploads, and versions past their retention.
  if (blobStorage) setInterval(() => { blobStorage.sweep().catch(() => console.error(JSON.stringify({ event: 'blob.sweep_unavailable' }))); }, 60_000).unref();

  console.log(`\n⚡ Carbon Database Studio running at: http://localhost:${server.port}`);
  console.log(`📡 API & Database services active (Relational, Vector, Graph, Functions, Storage)`);
  console.log(`🔑 Identity delegated to carbon-cloud at ${config.controlPlaneUrl}`);

  return { server, deps };
}

if (import.meta.main) {
  startDatabase();
}
