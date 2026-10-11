import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunFunctionRunner, DisposableWorkspaces, HttpBuildProtocol, RunLeasedFunctionUseCase } from '@carbon/worker';
import { takeSetting } from './build-worker.ts';

// A function worker: one machine, one execution at a time, each in its own
// child process and its own workspace, both gone before the result is
// reported. It talks to Cloud only through the worker API. Enroll it with the
// `function` purpose only: it refuses build leases.
if (import.meta.main) {
  const env = process.env;
  const cloudUrl = takeSetting(env, 'CARBON_CLOUD_URL'); const token = takeSetting(env, 'CARBON_WORKER_TOKEN');
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'OBJECT_STORE_SECRET_ACCESS_KEY']) delete env[name];
  const root = takeSetting(env, 'CARBON_WORKER_WORKSPACE', false) || join(tmpdir(), 'carbon-function-worker');
  const run = new RunLeasedFunctionUseCase(new HttpBuildProtocol(cloudUrl, token), new DisposableWorkspaces(root), new BunFunctionRunner());
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    let outcome = 'idle';
    try { outcome = await run.execute(); if (outcome !== 'idle') console.log(JSON.stringify({ event: 'worker.function', outcome })); }
    catch { console.error(JSON.stringify({ event: 'worker.function.unavailable' })); }
    if (outcome === 'idle') await Bun.sleep(1000);
  }
}
