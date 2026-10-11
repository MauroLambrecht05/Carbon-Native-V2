// Composition root for carbon-registry: opens the real Postgres
// connection, runs migrations, builds the real S3-compatible object-
// storage client, wires up an HttpIdentityClient pointed at carbon-cloud
// (real SSO — this product keeps no organizations/api_tokens of its own,
// see HttpIdentityClient's own header comment), constructs the real
// RegistryEngine, attaches HTTP routes, and launches the server.

import { HttpIdentityClient, assertionTrustFromEnv } from "@carbon/identity";
import { composeLifecyclePlatform, type LifecyclePlatformConfig, type PublishingConfig } from './lifecycle-platform.ts';
import { S3RegistryArchiveStore } from '@carbon/catalog';
import { parseComponent } from '@carbon/contracts/platform';
import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";
import { RegistryEngine } from "../infrastructure/services/RegistryEngine.ts";
import { TrustSigner } from "../infrastructure/services/TrustSigner.ts";
import { buildRegistryRoutes } from "../infrastructure/http/routes.ts";
import { startRegistryServer } from "../infrastructure/http/server.ts";

export interface CarbonRegistryConfig {
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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonRegistryConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  const trust = assertionTrustFromEnv(env);
  const objectStore = { endpoint: required("OBJECT_STORE_ENDPOINT"), accessKeyId: required("OBJECT_STORE_ACCESS_KEY_ID"), secretAccessKey: required("OBJECT_STORE_SECRET_ACCESS_KEY"), bucket: required("OBJECT_STORE_BUCKET") };
  return {
    internalPlatform: trust ? { trust, authorityOrigin: required('CARBON_AUTHORITY_ORIGIN'), publishing: publishingFromEnv(env, objectStore) } : undefined,
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

/**
 * Publishing is on only when CARBON_REGISTRY_PUBLISHING is `enabled`, and then every setting is required. The
 * signing seed and the root-signed trust bundle come from the deployment; nothing is generated here.
 */
export function publishingFromEnv(env: NodeJS.ProcessEnv, objectStore: CarbonRegistryConfig['objectStore']): PublishingConfig | undefined {
  if (!env.CARBON_REGISTRY_PUBLISHING || env.CARBON_REGISTRY_PUBLISHING === 'disabled') return undefined;
  if (env.CARBON_REGISTRY_PUBLISHING !== 'enabled') throw new Error('CARBON_REGISTRY_PUBLISHING must be enabled or disabled');
  const take = (name: string): string => { const value = env[name]; if (!value) throw new Error(`Registry publishing requires ${name}`); delete env[name]; return value; };
  let trustBundle; try { trustBundle = parseComponent('RegistryTrustBundle', JSON.parse(take('CARBON_REGISTRY_TRUST_BUNDLE'))); } catch { throw new Error('CARBON_REGISTRY_TRUST_BUNDLE must be a signed trust bundle'); }
  return { store: new S3RegistryArchiveStore(objectStore), origin: take('CARBON_REGISTRY_PUBLIC_ORIGIN'), rootPublicKey: take('CARBON_REGISTRY_ROOT_PUBLIC_KEY'), trustBundle,
    signingKeyId: take('CARBON_REGISTRY_SIGNING_KEY_ID'), signingSeed: take('CARBON_REGISTRY_SIGNING_SEED') };
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

  // Undefined CARBON_TRUST_PRIVATE_KEY mints a random ephemeral signing
  // key instead of refusing to start — same "loud fallback, not a hard
  // failure" posture carbon-cloud's own FakeCheckoutSessionProvider takes
  // for a missing STRIPE_SECRET_KEY. Fine for local dev/tests; a real
  // deployment must set this (generate one with
  // `carbon-plugin-sign keygen --out <path>`, then export its hex seed),
  // or every restart re-signs every plugin under a NEW key and every
  // previously-issued signature stops verifying.
  if (!process.env.CARBON_TRUST_PRIVATE_KEY) {
    console.warn(
      "\n⚠️  CARBON_TRUST_PRIVATE_KEY not set — publishing under a random ephemeral signing key.\n" +
        "   Fine for local dev; a real deployment must set this to a stable key\n" +
        "   (generate one with `carbon-plugin-sign keygen`) or every restart\n" +
        "   invalidates every previously-published plugin's signature.\n",
    );
  }
  const signer = TrustSigner.fromHexSeed(process.env.CARBON_TRUST_PRIVATE_KEY);
  const registryEngine = new RegistryEngine(sql, s3, signer);
  await registryEngine.seedIfEmpty();

  const deps = { sql, controlPlaneUrl: config.controlPlaneUrl, verifyToken, registryEngine };
  const legacyHandler = buildRegistryRoutes(deps);
  const lifecycle = config.internalPlatform ? composeLifecyclePlatform(sql, config.internalPlatform) : undefined;
  const handler = (request: Request) => /^\/(internal\/platform|registry)\/v1\//.test(new URL(request.url).pathname)
    ? lifecycle ? lifecycle(request) : Promise.resolve(Response.json({ error: { code: 'capability', message: 'Internal platform is not configured', requestId: crypto.randomUUID() } }, { status: 501, headers: { 'cache-control': 'no-store' } }))
    : legacyHandler(request);

  return { deps, handler };
}

export async function startRegistry(config: CarbonRegistryConfig = configFromEnv()) {
  const { deps, handler } = await buildRegistrySystem(config);
  const server = startRegistryServer({ port: config.port, handler });

  console.log(`\n🏪 Carbon Plugin Registry & Marketplace running at: http://localhost:${server.port}`);
  console.log(`📦 Native plugin search, semver resolution, and package publishing online`);
  console.log(`🛡️  Identity delegated to carbon-cloud at ${config.controlPlaneUrl}`);
  console.log(`🔏 Signing publishes with Ed25519 public key: ${deps.registryEngine.getPublicKeyHex()}`);

  return { server, deps };
}

if (import.meta.main) {
  startRegistry();
}
