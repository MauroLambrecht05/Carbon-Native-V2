// The composition root: builds the Postgres pool and object-storage client,
// wires cloud-orchestration's use cases to PostgresBuildRepository, mounts
// infrastructure/http's routes, starts the server. Nothing here decides
// what a build IS or does — that's cloud-orchestration. This only wires.

import {
  ClaimNextBuildUseCase,
  CompleteBuildUseCase,
  CreateBuildUseCase,
  GetBuildUseCase,
  ListOrgBuildsUseCase,
  PostgresBuildRepository,
} from "@carbon/orchestration";
import {
  CreateOrganizationUseCase,
  IssueWorkerTokenUseCase,
  PostgresIdentityRepository,
  VerifyTokenUseCase,
  assertionTrustFromEnv, type AssertionTrust,
} from "@carbon/identity";
import {
  ConsumeMagicLinkUseCase,
  PostgresAuthRepository,
  RequestMagicLinkUseCase,
  VerifyEndUserSessionUseCase,
} from "@carbon/auth";
import {
  CheckUsageLimitUseCase,
  PostgresBillingRepository,
  RecordBuildUsageUseCase,
  StartPlanUpgradeUseCase,
  ConfirmPlanUpgradeUseCase,
  FakeCheckoutSessionProvider,
  StripeCheckoutProvider,
  type CheckoutSessionProvider,
} from "@carbon/billing";
import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";
import { buildRoutes } from "../infrastructure/http/routes.ts";
import { accountPlatformConfigFromEnv, composeAccountPlatform, legacyTokenConfigFromEnv, type AccountPlatformConfig, type LegacyTokenConfig } from "./account-platform.ts";
import { composeServiceAuthority } from './service-authority.ts';

export interface CarbonCloudConfig {
  readonly assertionTrust?: AssertionTrust;
  readonly accountPlatform?: AccountPlatformConfig;
  readonly legacyTokens?: LegacyTokenConfig;
  readonly databaseUrl: string;
  readonly port: number;
  readonly objectStore: {
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly bucket: string;
    readonly publicBaseUrl: string;
  };
  /**
   * Undefined unless STRIPE_SECRET_KEY is set — startServer falls back to
   * FakeCheckoutSessionProvider (no real charge, no webhook verification
   * possible) the same way RealLocalPipeline treats signingKey/macos as
   * optional. STRIPE_PRICE_ID_PRO etc. name one env var per paid PlanId.
   */
  readonly stripe?: {
    readonly secretKey: string;
    readonly webhookSecret: string;
    readonly priceIds: Partial<Record<import("@carbon/billing").PlanId, string>>;
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonCloudConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  const stripeSecretKey = env.STRIPE_SECRET_KEY;
  return {
    assertionTrust: assertionTrustFromEnv(env),
    accountPlatform: accountPlatformConfigFromEnv(env),
    legacyTokens: legacyTokenConfigFromEnv(env),
    databaseUrl: required("DATABASE_URL"),
    port: Number(env.PORT ?? 8080),
    objectStore: {
      endpoint: required("OBJECT_STORE_ENDPOINT"),
      accessKeyId: required("OBJECT_STORE_ACCESS_KEY_ID"),
      secretAccessKey: required("OBJECT_STORE_SECRET_ACCESS_KEY"),
      bucket: required("OBJECT_STORE_BUCKET"),
      publicBaseUrl: required("OBJECT_STORE_PUBLIC_BASE_URL"),
    },
    stripe: stripeSecretKey
      ? {
          secretKey: stripeSecretKey,
          webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
          priceIds: { pro: env.STRIPE_PRICE_ID_PRO },
        }
      : undefined,
  };
}

export async function startServer(config: CarbonCloudConfig) {
  const sql = openDatabase(config.databaseUrl);
  await migrate(sql);

  const builds = new PostgresBuildRepository(sql);
  const identity = new PostgresIdentityRepository(sql);
  const billing = new PostgresBillingRepository(sql);
  const auth = new PostgresAuthRepository(sql);
  const accountPlatform = config.accountPlatform ? composeAccountPlatform(sql, config.accountPlatform) : undefined;
  if (config.assertionTrust && !accountPlatform) throw new Error('Internal service authority requires enabled account platform configuration');
  const serviceAuthority = config.assertionTrust ? composeServiceAuthority(sql, config.assertionTrust) : undefined;

  const checkoutProvider: CheckoutSessionProvider = config.stripe
    ? new StripeCheckoutProvider({ secretKey: config.stripe.secretKey, priceIds: config.stripe.priceIds })
    : new FakeCheckoutSessionProvider();

  const routes = buildRoutes({
    createBuild: new CreateBuildUseCase(builds),
    getBuild: new GetBuildUseCase(builds),
    listOrgBuilds: new ListOrgBuildsUseCase(builds),
    claimNext: new ClaimNextBuildUseCase(builds),
    completeBuild: new CompleteBuildUseCase(builds),
    createOrganization: new CreateOrganizationUseCase(identity),
    issueWorkerToken: new IssueWorkerTokenUseCase(identity),
    verifyToken: new VerifyTokenUseCase(identity),
    legacyTokens: config.legacyTokens,
    requestMagicLink: new RequestMagicLinkUseCase(auth),
    consumeMagicLink: new ConsumeMagicLinkUseCase(auth),
    verifyEndUserSession: new VerifyEndUserSessionUseCase(auth),
    checkUsageLimit: new CheckUsageLimitUseCase(billing, billing),
    recordBuildUsage: new RecordBuildUsageUseCase(billing),
    startPlanUpgrade: new StartPlanUpgradeUseCase(checkoutProvider),
    confirmPlanUpgrade: new ConfirmPlanUpgradeUseCase(billing),
    stripeWebhookSecret: config.stripe?.webhookSecret,
  });

  return Bun.serve({
    port: config.port,
    routes,
    fetch: (request, server) => {
      if (new URL(request.url).pathname === '/internal/platform/v1/authority') return serviceAuthority ? serviceAuthority(request)
        : Response.json({ current: false }, { status: 503, headers: { 'cache-control': 'no-store' } });
      if (new URL(request.url).pathname.startsWith("/app/v1/")) {
        if (accountPlatform) return accountPlatform.appHandler(request, server.requestIP(request)?.address ?? "unknown");
        const requestId = crypto.randomUUID();
        return Response.json({ error: { code: "capability", message: "App authentication is not configured", requestId } }, { status: 501, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      if (new URL(request.url).pathname.startsWith("/worker/v1/")) {
        if (accountPlatform?.workerHandler) return accountPlatform.workerHandler(request, server.requestIP(request)?.address ?? "unknown");
        const requestId = crypto.randomUUID();
        return Response.json({ error: { code: "capability", message: "Workers are not configured", requestId } }, { status: 501, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      if (new URL(request.url).pathname.startsWith("/platform/v1/")) {
        if (accountPlatform) return accountPlatform.handler(request, server.requestIP(request)?.address ?? "unknown");
        const requestId = crypto.randomUUID();
        return Response.json({ error: { code: "capability", message: "Account platform is not configured", requestId } }, { status: 501, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
}
