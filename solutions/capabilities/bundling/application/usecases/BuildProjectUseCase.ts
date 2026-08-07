// Shared steps used by `build` and `run`. Each is idempotent: if there's
// nothing to do the step prints a hint and returns.
//
// ── ON THE LOGGER PARAMETER ─────────────────────────────────────────────────
// Every entry point takes a Logger. It used to import `log` and `c` from
// @carbon/logging directly, which put an application-layer file on a concrete
// console adapter — the one dependency direction this layering exists to
// forbid. The product passes the adapter in, because the product is the
// composition root.
//
// The colour calls went with it rather than moving to the port. A build step
// knows that a cache was hit; whether that reads green is the caller's
// decision, and a CI adapter emitting JSON has no answer for `c.green`.

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
// vite is dynamic-imported inside `buildVite` so cache-hit `carbon build`
// runs do not pay the ~200 ms vite + rollup module-evaluation cost.
import type { Logger } from "@carbon/logging";
import { run as spawnRun } from "@carbon/process";
import {
  artifactsExist,
  computeCacheKey,
  expectedArtifacts,
  readCache,
  writeCache,
} from "../../infrastructure/BuildCache.ts";
import { resolveBackendBinary, runtimeBinaryPath, runtimeCargoDir, SCRIPTS_DIR, supportsMiniBytecode, usesMiniBundlePipeline } from "@carbon/workspace";
import { backendCargoFeatures, type BackendName } from "@carbon/contracts/app/backend";

/** `bun install` if node_modules doesn't exist yet. */
export async function ensureNodeModules(projectDir: string, logger: Logger): Promise<void> {
  const pkgJson = join(projectDir, "package.json");
  if (!existsSync(pkgJson)) return;  // no JS deps to install
  const nodeModules = join(projectDir, "node_modules");
  if (existsSync(nodeModules)) return;
  logger.step(`installing dependencies (bun install)…`);
  const { code } = await spawnRun("bun", ["install"], { cwd: projectDir });
  if (code !== 0) throw new Error(`bun install failed (exit ${code})`);
}

/** `cargo build --release` for the chosen backend if its binary doesn't exist yet. */
export async function ensureRuntime(backend: BackendName, logger: Logger): Promise<string> {
  // Search dist before release (resolveBackendBinary's order) rather than
  // hardcoding runtimeBinaryPath's "release" default — a dist-only build
  // (no release binary at all) must still resolve to the binary that
  // actually exists, not a path nothing was ever written to.
  const existing = resolveBackendBinary(backend);
  if (existing) return existing;
  const exe = runtimeBinaryPath(backend);

  logger.step(`runtime binary not built — running cargo build --release for ${backend}…`);
  const dir = runtimeCargoDir(backend);
  // mini and blitz are two `[[bin]]` targets in one package with no default
  // features (see carbon/runtime/Cargo.toml) — both --bin and --features
  // must be explicit, or cargo has no runnable target to select.
  const cargoArgs = [
    "build", "--release",
    "--bin", `carbon-${backend}`,
    "--no-default-features",
    "--features", backendCargoFeatures(backend),
  ];
  const { code } = process.platform === "win32"
    ? await spawnRun(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. "${join(SCRIPTS_DIR, "activate-msvc.ps1")}"; cargo ${cargoArgs.join(" ")}`,
        ],
        { cwd: dir },
      )
    : await spawnRun("cargo", cargoArgs, { cwd: dir });
  if (code !== 0) throw new Error(`cargo build for ${backend} failed (exit ${code})`);
  if (!existsSync(exe)) {
    throw new Error(`cargo finished but binary not at expected path: ${exe}`);
  }
  return exe;
}

/**
 * Run our bun-build + Babel pipeline. Replaces Vite for the carbon-mini
 * backend — same plugin chain (carbon-transforms + carbon-tailwind +
 * babel-preset-solid universal), without Vite + Rollup's config-load and
 * graph-build overhead. See build-pipeline.ts for the gory bits.
 */
async function buildMiniBundle(
  projectDir: string,
  logger: Logger,
  opts: { noBabelCache?: boolean; wrapIife?: boolean } = {},
): Promise<void> {
  const candidates = [
    // .ctsx is carbon-mini's custom DSL extension — checked first so
    // projects that use it win over a leftover .tsx with the same name.
    "src/main.ctsx", "src/App.ctsx", "src/index.ctsx",
    "main.ctsx", "App.ctsx", "index.ctsx",
    // main.tsx wins over App.tsx so React projects (which split into
    // App.tsx-component + main.tsx-entry per Vite/CRA convention) pick
    // the entry that actually calls render(). For single-file presets
    // (blank, native) only one of these exists, so order doesn't matter.
    "src/main.tsx", "src/App.tsx", "src/index.tsx", "src/counter.tsx",
    "main.tsx", "App.tsx", "index.tsx", "counter.tsx",
  ];
  const entry = candidates.find((c) => existsSync(join(projectDir, c)));
  if (!entry) {
    logger.warn(`no entry .tsx found (looked for ${candidates.join(", ")}) — skipping bundle build`);
    return;
  }
  // Lazy import so non-mini cache-hit runs do not pay the ~50 ms Babel +
  // preset-solid module-evaluation cost.
  const { buildBundleWithBabel, buildBundleSplit, splitEnabled } = await import("../../infrastructure/BunBundler.ts");
  if (splitEnabled()) {
    // Vendor/app split: node_modules → dist/vendor.js (once), app → bundle.js.
    logger.step(`building ${entry} → dist/{vendor,bundle}.js (split)…`);
    await buildBundleSplit({
      projectDir,
      entry,
      outFile: "dist/bundle.js",
      solid: { generate: "universal", moduleName: "@carbon/mini-solid" },
      noBabelCache: opts.noBabelCache,
      wrapIife: opts.wrapIife,
    });
    return;
  }
  logger.step(`building ${entry} → dist/bundle.js (bun + babel)…`);
  // Non-split build: remove any stale dist/vendor.js so the runtime (which
  // evals vendor.js when present) doesn't pick up a leftover from a prior
  // split build and run with a stale/mismatched module registry.
  try { unlinkSync(join(projectDir, "dist", "vendor.js")); } catch { /* none */ }
  await buildBundleWithBabel({
    projectDir,
    entry,
    outFile: "dist/bundle.js",
    solid: { generate: "universal", moduleName: "@carbon/mini-solid" },
    noBabelCache: opts.noBabelCache,
    wrapIife: opts.wrapIife,
  });
}

/** Run Vite's programmatic build. */
async function buildVite(projectDir: string, logger: Logger): Promise<void> {
  logger.step(`building UI bundle (vite)…`);
  const { build: viteBuild } = await import("vite");
  await viteBuild({
    root: projectDir,
    logLevel: "warn",
    configFile: existsSync(join(projectDir, "vite.config.ts"))
      ? join(projectDir, "vite.config.ts")
      : existsSync(join(projectDir, "vite.config.js"))
      ? join(projectDir, "vite.config.js")
      : undefined,
  });
}

/** Bun-build src/shell.ts → dist/shell.js, if shell.ts exists. */
async function buildShell(projectDir: string, logger: Logger): Promise<void> {
  const shellSrc = join(projectDir, "src", "shell.ts");
  if (!existsSync(shellSrc)) return;
  logger.step(`building shell.js (bun)…`);
  const { code } = await spawnRun(
    "bun",
    [
      "build",
      "src/shell.ts",
      "--target=browser",
      "--format=esm",
      "--outdir",
      "dist",
    ],
    { cwd: projectDir },
  );
  if (code !== 0) throw new Error(`bun build shell.ts failed (exit ${code})`);
}

/**
 * Single-bundle build for backends that don't use Vite (mini today).
 * Looks for a conventional entry file at the project root and bun-builds
 * it to dist/bundle.js — mini's runtime reads that path directly.
 */
async function buildBundle(projectDir: string, logger: Logger): Promise<void> {
  const candidates = [
    // .ctsx is carbon-mini's custom DSL extension — checked first so
    // projects that use it win over a leftover .tsx with the same name.
    "src/main.ctsx", "src/App.ctsx", "src/index.ctsx",
    "main.ctsx", "App.ctsx", "index.ctsx",
    // main.tsx wins over App.tsx so React projects (which split into
    // App.tsx-component + main.tsx-entry per Vite/CRA convention) pick
    // the entry that actually calls render(). For single-file presets
    // (blank, native) only one of these exists, so order doesn't matter.
    "src/main.tsx", "src/App.tsx", "src/index.tsx", "src/counter.tsx",
    "main.tsx", "App.tsx", "index.tsx", "counter.tsx",
  ];
  const entry = candidates.find((c) => existsSync(join(projectDir, c)));
  if (!entry) {
    logger.warn(`no entry .tsx found (looked for ${candidates.join(", ")}) — skipping bundle build`);
    return;
  }
  logger.step(`building ${entry} → dist/bundle.js (bun)…`);
  const { code } = await spawnRun(
    "bun",
    [
      "build",
      entry,
      "--target=browser",
      "--format=esm",
      "--outfile=dist/bundle.js",
    ],
    { cwd: projectDir },
  );
  if (code !== 0) throw new Error(`bun build failed (exit ${code})`);
}

/**
 * Optional post-build step: compile the JS bundle to lz4-compressed QuickJS
 * bytecode (.qbc.zst). Only runs when [runtime] bytecode = true in carbon.toml
 * AND the chosen backend supports it (mini today; webview2 + verso could later).
 *
 * Invokes `<runtime-binary> --compile-bundle <input> <output>` so the same
 * QuickJS version compiles + runs the bytecode (avoids version-mismatch errors).
 */
async function compileBytecode(projectDir: string, backend: BackendName, logger: Logger): Promise<void> {
  const exe = runtimeBinaryPath(backend);
  if (!existsSync(exe)) {
    logger.warn(`bytecode requested but ${exe} not built yet — skipping`);
    return;
  }
  // Find the JS bundle the runtime would otherwise load.
  const candidates = [
    join(projectDir, "dist", "bundle.js"),
    join(projectDir, "dist", "shell.js"),
  ];
  const inputJs = candidates.find((c) => existsSync(c));
  if (!inputJs) {
    logger.warn(`bytecode requested but no dist/bundle.js or dist/shell.js found — skipping`);
    return;
  }
  // Drop the .js extension, append .qbc.zst.
  const outputQbc = inputJs.replace(/\.js$/, ".qbc.zst");
  // Remove any stale .qbc.zst before re-compiling so the runtime never picks up
  // an out-of-date file if the compile fails halfway.
  try { unlinkSync(outputQbc); } catch {}
  logger.step(`compiling ${inputJs} → ${outputQbc} (bytecode + lz4)…`);
  const { code } = await spawnRun(exe, ["--compile-bundle", inputJs, outputQbc]);
  if (code !== 0) throw new Error(`bytecode compile failed (exit ${code})`);
}

/**
 * Build the startup heap snapshot (mini backend only). Runs the runtime with
 * `--snapshot-build <projectDir>`, which evaluates the bundle's module-init into
 * a fixed-address arena and dumps it to `dist/bundle.cmsnap.raw` (+ `.meta`).
 * On startup the runtime auto-restores from it instead of re-evaluating the
 * bundle (gated by a code-fingerprint + mtime check, so a stale snapshot is
 * simply ignored).
 *
 * Best-effort: a runtime built WITHOUT the `snapshot` feature recognises the
 * flag and exits without producing a snapshot — we just remove any stale one so
 * the runtime falls back to the cold path cleanly.
 */
async function buildSnapshot(projectDir: string, backend: BackendName, logger: Logger): Promise<void> {
  if (backend !== "mini") return;
  // Opt-in (CARBON_SNAPSHOT=1). The startup snapshot is experimental: it can
  // change behaviour for apps that derive state from host fns at module-init,
  // so it's not built/used by default. Set CARBON_SNAPSHOT=1 to build + use it.
  if (!process.env.CARBON_SNAPSHOT) {
    for (const f of ["dist/bundle.cmsnap.raw", "dist/bundle.cmsnap.meta"]) {
      try { unlinkSync(join(projectDir, f)); } catch { /* not present */ }
    }
    return;
  }
  const exe = runtimeBinaryPath(backend);
  if (!existsSync(exe)) return;
  logger.step(`building startup heap snapshot (dist/bundle.cmsnap.raw)…`);
  // Drop the old snapshot first so a failed/no-op build never leaves a stale one.
  for (const f of ["dist/bundle.cmsnap.raw", "dist/bundle.cmsnap.meta"]) {
    try { unlinkSync(join(projectDir, f)); } catch { /* not present */ }
  }
  try {
    const { code } = await spawnRun(exe, ["--snapshot-build", projectDir]);
    if (code !== 0) {
      logger.warn(`snapshot build skipped (exit ${code}) — runtime will use the cold path`);
    }
  } catch (e) {
    logger.warn(`snapshot build skipped (${(e as Error).message}) — runtime will use the cold path`);
  }
}

/**
 * Dispatch the build step based on project shape:
 *   - Has vite.config.{ts,js}     → vite build (UI) + bun build shell.ts (shell)
 *   - No vite config              → bun build a single entry → dist/bundle.js
 *
 * Both shapes are valid carbon apps; the runtime that reads them knows where
 * to find the artifacts (see runtime/<backend>/native/src/main.rs for the load paths).
 *
 * Wraps the actual build in a content-hash cache: if no source file has
 * changed (and the runtime + CLI haven't changed) since the last successful
 * build, skips Vite + bun build + bytecode compile entirely. Restores the
 * full ~700 ms `carbon run` overhead to ~10 ms (just hash + spawn).
 */
export async function buildProject(
  projectDir: string,
  backend: BackendName,
  logger: Logger,
  opts: { bytecode?: boolean; force?: boolean; noBabelCache?: boolean; dev?: boolean } = {},
): Promise<void> {
  const requestedBytecode = !!opts.bytecode;
  const bytecode = requestedBytecode && supportsMiniBytecode(backend);
  // Wrap the bundle in an IIFE only when building for the dev/HMR loop AND
  // emitting bytecode — that's the one path that re-evals compiled bytecode
  // in a live context (where top-level `const` would redeclare). Production
  // (carbon run/build) leaves it off so cold-start eval stays fast.
  const wrapIife = !!opts.dev && bytecode;
  const t0 = performance.now();
  const key = computeCacheKey(projectDir, backend, bytecode, !!opts.dev);
  const tHash = performance.now() - t0;

  if (!opts.force) {
    const prev = readCache(projectDir);
    if (prev && prev.key === key && artifactsExist(projectDir, prev.artifacts)) {
      logger.step(
        `cache hit (key ${key.slice(0, 12)}, ${tHash.toFixed(0)} ms hash) — skipping rebuild`,
      );
      return;
    }
  }

  // Cache miss — actually build.
  mkdirSync(join(projectDir, "dist"), { recursive: true });
  const hasVite = existsSync(join(projectDir, "vite.config.ts"))
                || existsSync(join(projectDir, "vite.config.js"));
  // The mini backend gets the bun-build + Babel pipeline whether or not it
  // has a vite.config.ts — its config (solid universal mode + carbon plugins)
  // is fixed and the new pipeline implements that chain natively. Other
  // backends (webview2, verso) still use Vite for the UI bundle since they
  // ship features the new pipeline does not (HTML emission, asset handling).
  const _tb = performance.now();
  if (usesMiniBundlePipeline(backend) && process.env.CARBON_USE_VITE !== "1") {
    await buildMiniBundle(projectDir, logger, { noBabelCache: opts.noBabelCache, wrapIife });
  } else if (hasVite) {
    await buildVite(projectDir, logger);
    await buildShell(projectDir, logger);
  } else {
    await buildBundle(projectDir, logger);
  }
  if (!process.env.CARBON_NO_TIMING) logger.step(`[timing] build.transform+bundle = ${(performance.now() - _tb).toFixed(0)} ms`);
  if (bytecode) {
    const _tc = performance.now();
    await compileBytecode(projectDir, backend, logger);
    if (!process.env.CARBON_NO_TIMING) logger.step(`[timing] build.bytecode = ${(performance.now() - _tc).toFixed(0)} ms`);
  } else if (requestedBytecode) {
    logger.warn(`bytecode requested but ${backend} does not support it yet - emitting dist/bundle.js`);
    for (const stale of ["dist/bundle.qbc.zst", "dist/bundle.qbc"]) {
      try { unlinkSync(join(projectDir, stale)); } catch { /* not present */ }
    }
  } else {
    // Not emitting bytecode this build — remove any stale dist/bundle.qbc.zst
    // so the runtime (which prefers .qbc.zst) loads the fresh .js instead of a
    // leftover bytecode artifact from a previous `carbon run`/`--release` build.
    // This is what lets `carbon dev` (plain .js) reload correctly after a prior
    // production build left bytecode behind.
    for (const stale of ["dist/bundle.qbc.zst", "dist/bundle.qbc"]) {
      try { unlinkSync(join(projectDir, stale)); } catch { /* not present */ }
    }
  }

  // Startup heap snapshot — built for production/run, NOT the dev/HMR loop
  // (where the bundle changes every save and the snapshot would just be skipped
  // as stale). Must run AFTER the bytecode compile so it snapshots the same
  // artifact the runtime loads.
  if (!opts.dev) {
    const _ts = performance.now();
    await buildSnapshot(projectDir, backend, logger);
    if (!process.env.CARBON_NO_TIMING) logger.step(`[timing] build.snapshot = ${(performance.now() - _ts).toFixed(0)} ms`);
  } else {
    for (const stale of ["dist/bundle.cmsnap.raw", "dist/bundle.cmsnap.meta"]) {
      try { unlinkSync(join(projectDir, stale)); } catch { /* not present */ }
    }
  }

  // Persist the cache entry.
  const artifacts = expectedArtifacts(projectDir, bytecode);
  writeCache(projectDir, key, artifacts);
  if (!process.env.CARBON_NO_TIMING) logger.step(`[timing] build.TOTAL = ${(performance.now() - t0).toFixed(0)} ms`);
}
