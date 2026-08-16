// The composition root: builds the Postgres pool and object-storage client,
// wires cloud-orchestration's use cases to PostgresBuildRepository, mounts
// infrastructure/http's routes, starts the server. Nothing here decides
// what a build IS or does — that's cloud-orchestration. This only wires.

import {
  ClaimNextBuildUseCase,
  CompleteBuildUseCase,
  CreateBuildUseCase,
  GetBuildUseCase,
  PostgresBuildRepository,
} from "@carbon/cloud-orchestration";
import {
  CreateOrganizationUseCase,
  IssueWorkerTokenUseCase,
  PostgresIdentityRepository,
  VerifyTokenUseCase,
} from "@carbon/identity";
import {
  CheckUsageLimitUseCase,
  PostgresBillingRepository,
  RecordBuildUsageUseCase,
} from "@carbon/billing";
import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";
import { buildRoutes } from "../infrastructure/http/routes.ts";

export interface CarbonCloudConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly objectStore: {
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly bucket: string;
    readonly publicBaseUrl: string;
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonCloudConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  return {
    databaseUrl: required("DATABASE_URL"),
    port: Number(env.PORT ?? 8080),
    objectStore: {
      endpoint: required("OBJECT_STORE_ENDPOINT"),
      accessKeyId: required("OBJECT_STORE_ACCESS_KEY_ID"),
      secretAccessKey: required("OBJECT_STORE_SECRET_ACCESS_KEY"),
      bucket: required("OBJECT_STORE_BUCKET"),
      publicBaseUrl: required("OBJECT_STORE_PUBLIC_BASE_URL"),
    },
  };
}

export async function startServer(config: CarbonCloudConfig) {
  const sql = openDatabase(config.databaseUrl);
  await migrate(sql);

  const builds = new PostgresBuildRepository(sql);
  const identity = new PostgresIdentityRepository(sql);
  const billing = new PostgresBillingRepository(sql);
  const routes = buildRoutes({
    createBuild: new CreateBuildUseCase(builds),
    getBuild: new GetBuildUseCase(builds),
    claimNext: new ClaimNextBuildUseCase(builds),
    completeBuild: new CompleteBuildUseCase(builds),
    createOrganization: new CreateOrganizationUseCase(identity),
    issueWorkerToken: new IssueWorkerTokenUseCase(identity),
    verifyToken: new VerifyTokenUseCase(identity),
    checkUsageLimit: new CheckUsageLimitUseCase(billing, billing),
    recordBuildUsage: new RecordBuildUsageUseCase(billing),
  });

  return Bun.serve({
    port: config.port,
    routes,
    fetch: () => new Response("not found", { status: 404 }),
  });
}
