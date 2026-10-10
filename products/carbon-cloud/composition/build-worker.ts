import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@carbon/logging';
import { nodeProcessRunner } from '@carbon/process';
import { CarbonBuildPipeline, DisposableWorkspaces, GitSourceCheckout, HttpBuildProtocol, RealLocalPipeline, RunLeasedBuildUseCase, S3ArtifactUploader } from '@carbon/worker';

/**
 * Reads a setting and removes it from the process environment. A build runs the project's own scripts as child
 * processes; whatever stays in the environment is theirs to read, so the worker's credentials must not stay.
 */
export function takeSetting(env: Record<string, string | undefined>, name: string, required = true): string {
  const value = env[name]; delete env[name];
  if (!value && required) throw new Error(`${name} is required`);
  return value ?? '';
}

// A build worker: one machine, one build at a time, each in a workspace that
// is created for the attempt and erased before the result is reported. It
// talks to Cloud only through the worker API and never to the database.
if (import.meta.main) {
  const env = process.env;
  const cloudUrl = takeSetting(env, 'CARBON_CLOUD_URL'); const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const enrollmentCode = takeSetting(env, 'CARBON_WORKER_ENROLLMENT_CODE', false);
  // A first start trades the one-time enrollment code for the credential and prints it once for the operator to store.
  if (enrollmentCode) {
    const token = await HttpBuildProtocol.enroll(cloudUrl, enrollmentCode, { platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', toolchains: [`bun-${Bun.version}`] });
    console.log(JSON.stringify({ event: 'worker.enrolled', token })); process.exit(0);
  }
  const token = takeSetting(env, 'CARBON_WORKER_TOKEN');
  const store = { type: 's3' as const, prefix: '', bucket: takeSetting(env, 'OBJECT_STORE_BUCKET'), endpoint: takeSetting(env, 'OBJECT_STORE_ENDPOINT'),
    accessKeyId: takeSetting(env, 'OBJECT_STORE_ACCESS_KEY_ID'), secretAccessKey: takeSetting(env, 'OBJECT_STORE_SECRET_ACCESS_KEY') };
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'DATABASE_URL']) delete env[name];
  const root = takeSetting(env, 'CARBON_WORKER_WORKSPACE', false) || join(tmpdir(), 'carbon-build-worker');
  const run = new RunLeasedBuildUseCase(new HttpBuildProtocol(cloudUrl, token), new GitSourceCheckout(nodeProcessRunner), new DisposableWorkspaces(root),
    new CarbonBuildPipeline(authenticode => new RealLocalPipeline(log, undefined, authenticode)), new S3ArtifactUploader(store), { redact: [token, store.secretAccessKey] });
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    let outcome = 'idle';
    try { outcome = await run.execute(); if (outcome !== 'idle') console.log(JSON.stringify({ event: 'worker.build', outcome })); }
    catch { console.error(JSON.stringify({ event: 'worker.build.unavailable' })); }
    if (outcome === 'idle') await Bun.sleep(5000);
  }
}
