// @carbon/bundling — source into a runnable bundle.
//
//   application/ports/  Bundler — what produces the bytes
//   application/usecases/  the build pipeline
//   infrastructure/     the Bun.build adapter, and the content-hash cache
//
// BunBundler is not re-exported: evaluating it costs ~68 ms because it pulls in
// the Vite plugin chain, and the pipeline imports it lazily. Reach for
// @carbon/bundling/bundler if you genuinely need it.

export { buildProject, ensureNodeModules, ensureRuntime } from "./application/usecases/BuildProjectUseCase.ts";
export { computeCacheKey } from "./infrastructure/BuildCache.ts";
export { installIsCurrent, installKey, writeInstallStamp } from "./infrastructure/InstallState.ts";
export type { Bundler, BundleRequest } from "./application/ports/Bundler.ts";
