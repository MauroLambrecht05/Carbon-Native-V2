#!/usr/bin/env bun
// A Linux build worker: polls the control plane, runs whatever it claims,
// reports back. Composes @carbon/cloud-workers the same way
// composition/entrypoint.ts composes @carbon/cloud-orchestration for the
// control plane — this is a worker's own composition root, not a second
// product (it ships as part of carbon-cloud, in its own container).

import { log } from "@carbon/logging";
import { nodeProcessRunner } from "@carbon/process";
import {
  GitRepoFetcher,
  HttpControlPlaneClient,
  RealLocalPipeline,
  RunNextJobUseCase,
  S3ArtifactUploader,
} from "@carbon/cloud-workers";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

const controlPlane = new HttpControlPlaneClient(
  requireEnv("CONTROL_PLANE_URL"),
  requireEnv("WORKER_API_TOKEN"),
);
const repos = new GitRepoFetcher(nodeProcessRunner);
const pipeline = new RealLocalPipeline(
  log,
  process.env.SIGNING_KEY_PATH && process.env.SIGNING_KEY_PASSWORD
    ? { keyFile: process.env.SIGNING_KEY_PATH, password: process.env.SIGNING_KEY_PASSWORD }
    : undefined,
);
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

const workerId = process.env.WORKER_ID ?? `linux-${crypto.randomUUID()}`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const workDir = process.env.WORK_DIR ?? "/tmp/carbon-cloud-worker";

const runJob = new RunNextJobUseCase(controlPlane, repos, pipeline, uploader, workerId, "linux", workDir);

log.info(`carbon-cloud worker ${workerId} (linux) polling every ${pollIntervalMs}ms`);

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
