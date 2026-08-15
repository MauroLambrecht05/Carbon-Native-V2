// Shared composition for any worker: the only thing that differs between
// worker-linux.ts and worker-windows.ts is which platform they claim for and
// which signing credentials apply, so that's the parameter, not a second
// copy of this wiring.

import { log } from "@carbon/logging";
import { nodeProcessRunner } from "@carbon/process";
import type { AuthenticodeCredentials, MacOsCredentials } from "@carbon/signing";
import type { TargetPlatform } from "@carbon/contracts/distribution";
import {
  GitRepoFetcher,
  HttpControlPlaneClient,
  RealLocalPipeline,
  RunNextJobUseCase,
  S3ArtifactUploader,
  type SigningKey,
} from "@carbon/cloud-workers";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export interface WorkerOptions {
  readonly platform: TargetPlatform;
  readonly defaultWorkDir: string;
  readonly signingKey?: SigningKey;
  readonly authenticode?: AuthenticodeCredentials;
  readonly macos?: MacOsCredentials;
}

export async function runWorker(options: WorkerOptions): Promise<never> {
  const controlPlane = new HttpControlPlaneClient(
    requireEnv("CONTROL_PLANE_URL"),
    requireEnv("WORKER_API_TOKEN"),
  );
  const repos = new GitRepoFetcher(nodeProcessRunner);
  const pipeline = new RealLocalPipeline(log, options.signingKey, options.authenticode, options.macos);
  const uploader = new S3ArtifactUploader(
    {
      type: "s3",
      bucket: requireEnv("OBJECT_STORE_BUCKET"),
      prefix: "",
      endpoint: requireEnv("OBJECT_STORE_ENDPOINT"),
      accessKeyId: requireEnv("OBJECT_STORE_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("OBJECT_STORE_SECRET_ACCESS_KEY"),
    },
    log,
  );

  const workerId = process.env.WORKER_ID ?? `${options.platform}-${crypto.randomUUID()}`;
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const workDir = process.env.WORK_DIR ?? options.defaultWorkDir;

  const runJob = new RunNextJobUseCase(
    controlPlane,
    repos,
    pipeline,
    uploader,
    workerId,
    options.platform,
    workDir,
  );

  log.info(`carbon-cloud worker ${workerId} (${options.platform}) polling every ${pollIntervalMs}ms`);

  // A plain poll loop, not a queue subscription: the control plane's claim
  // endpoint IS the queue (a `FOR UPDATE SKIP LOCKED` claim on the builds
  // table), so there is nothing to subscribe to — see
  // cloud-orchestration/infrastructure/PostgresBuildRepository.ts.
  for (;;) {
    try {
      const outcome = await runJob.execute();
      if (outcome !== "idle") log.info(`job ${outcome}`);
    } catch (error) {
      log.error(`worker loop error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
