// Composition root for carbon-registry: opens the real Postgres
// connection, runs migrations, builds the real S3-compatible object-
// storage client, wires up an HttpIdentityClient pointed at carbon-cloud
// (real SSO — this product keeps no organizations/api_tokens of its own,
// see HttpIdentityClient's own header comment), constructs the real
// RegistryEngine, attaches HTTP routes, and launches the server.

import { HttpIdentityClient } from "@carbon/identity";
import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";
import { RegistryEngine } from "../infrastructure/services/RegistryEngine.ts";
import { buildRegistryRoutes } from "../infrastructure/http/routes.ts";
import { startRegistryServer } from "../infrastructure/http/server.ts";

export interface CarbonRegistryConfig {
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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonRegistryConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  return {
    port: Number(env.PORT ?? 54323),
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

export async function buildRegistrySystem(config: CarbonRegistryConfig) {
  const sql = openDatabase(config.databaseUrl);
  await migrate(sql);

  const s3 = new Bun.S3Client({
    endpoint: config.objectStore.endpoint,
    accessKeyId: config.objectStore.accessKeyId,
    secretAccessKey: config.objectStore.secretAccessKey,
    bucket: config.objectStore.bucket,
  });

  const verifyToken = new HttpIdentityClient(config.controlPlaneUrl);
  const registryEngine = new RegistryEngine(sql, s3);
  await registryEngine.seedIfEmpty();

  const deps = { sql, controlPlaneUrl: config.controlPlaneUrl, verifyToken, registryEngine };
  const handler = buildRegistryRoutes(deps);

  return { deps, handler };
}

export async function startRegistry(config: CarbonRegistryConfig = configFromEnv()) {
  const { deps, handler } = await buildRegistrySystem(config);
  const server = startRegistryServer({ port: config.port, handler });

  console.log(`\n🏪 Carbon Plugin Registry & Marketplace running at: http://localhost:${server.port}`);
  console.log(`📦 Native plugin search, semver resolution, and package publishing online`);
  console.log(`🛡️  Identity delegated to carbon-cloud at ${config.controlPlaneUrl}`);

  return { server, deps };
}

if (import.meta.main) {
  startRegistry();
}
