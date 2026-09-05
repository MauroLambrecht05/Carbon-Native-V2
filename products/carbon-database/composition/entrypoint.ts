// Composition root for carbon-database: opens the real Postgres
// connection, runs migrations, builds the real S3-compatible object-
// storage client, wires up an HttpIdentityClient pointed at carbon-cloud
// (real SSO — this product keeps no organizations/api_tokens of its own,
// see HttpIdentityClient's own header comment), constructs every real
// engine, attaches HTTP routes, and launches the server.

import { HttpIdentityClient } from "@carbon/identity";
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

export interface CarbonDatabaseConfig {
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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonDatabaseConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  return {
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
  await migrate(sql);

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

  const handler = buildDatabaseRoutes(deps);
  return { deps, handler, realtime };
}

export async function startDatabase(config: CarbonDatabaseConfig = configFromEnv()) {
  const { handler, realtime, deps } = await buildDatabaseSystem(config);
  const server = startDatabaseServer({ port: config.port, handler, realtime });

  console.log(`\n⚡ Carbon Database Studio running at: http://localhost:${server.port}`);
  console.log(`📡 API & Database services active (Relational, Vector, Graph, Functions, Storage)`);
  console.log(`🔑 Identity delegated to carbon-cloud at ${config.controlPlaneUrl}`);

  return { server, deps };
}

if (import.meta.main) {
  startDatabase();
}
