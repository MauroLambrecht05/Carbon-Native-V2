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

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
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
import { installIsCurrent, installKey, writeInstallStamp } from "../../infrastructure/InstallState.ts";
import { distBinaryPath, resolveBackendBinary, runtimeBinaryPath, runtimeCargoDir, SCRIPTS_DIR, TARGET_DIR, supportsMiniBytecode, usesMiniBundlePipeline } from "@carbon/workspace";
import { backendCargoFeatures, type BackendName, type RuntimeFeatureFlags } from "@carbon/contracts/app/backend";

/**
 * `bun install --frozen-lockfile` when `node_modules` is missing OR no longer
 * corresponds to the package.json + lockfile on disk.
 *
 * ── --frozen-lockfile ───────────────────────────────────────────────────────
 * Verified against bun 1.3.10 (`bun install --help`): "--frozen-lockfile —
 * Disallow changes to lockfile". With it, a package.json that disagrees with
 * the lockfile fails the install ("error: lockfile had changes, but lockfile is
 * frozen") instead of quietly re-resolving a caret range to whatever was
 * published since — which is exactly how a compromised release gets pulled into
 * a build that believed it was pinned.
 *
 * It is applied only when a lockfile actually exists. With none, bun does
 * accept the flag (verified) — but it then installs WITHOUT writing one, so a
 * freshly scaffolded app would never acquire the lockfile that makes every
 * later build reproducible. First install resolves and writes; every install
 * after that is frozen. The security property lives in the second case, and
 * the first case is what creates the thing the second case enforces.
 *
 * ── WHY THE TRIGGER CHANGED ─────────────────────────────────────────────────
 * "install only if node_modules is absent" made the flag pointless: the one
 * moment a lockfile most needs checking — someone changed package.json or
 * pulled a new lockfile — is the moment node_modules already exists, so
 * nothing ran. See InstallState.ts for why this is a content stamp rather than
 * an unconditional `bun install` (Layer 0: the build-cache-hit path is ~10 ms
 * and an in-sync bun install still costs ~45 ms plus a spawn).
 */
export async function ensureNodeModules(
  projectDir: string,
  logger: Logger,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const pkgJson = join(projectDir, "package.json");
  if (!existsSync(pkgJson)) return;  // no JS deps to install
  const key = installKey(projectDir);
  const nodeModules = join(projectDir, "node_modules");
  if (existsSync(nodeModules) && installIsCurrent(projectDir, key)) return;

  const frozen = existsSync(join(projectDir, "bun.lock")) || existsSync(join(projectDir, "bun.lockb"));
  const args = frozen ? ["install", "--frozen-lockfile"] : ["install"];
  const shown = `bun ${args.join(" ")}`;
  logger.step(
    existsSync(nodeModules)
      ? `dependencies changed since last install — re-verifying (${shown})…`
      : `installing dependencies (${shown})…`,
  );
  // Frozen mode refuses rather than silently re-resolving, so a failure here is
  // a real signal (package.json and the lockfile disagree). It throws, and the
  // message names the one command that fixes it.
  //
  // Quiet mode pipes bun's own stdout/stderr instead of letting it print
  // straight to the terminal — its version banner + progress bar is noise on
  // every successful install, and the only thing worth surfacing is a short
  // summary. The full output is never lost: on failure it's dumped verbatim
  // before throwing, so nothing is harder to debug than before.
  const { code, stdout, stderr } = await spawnRun("bun", args, {
    cwd: projectDir,
    stdio: opts.quiet ? "pipe" : "inherit",
  });
  if (code !== 0) {
    if (opts.quiet) {
      if (stdout) logger.raw(stdout.trimEnd());
      if (stderr) logger.raw(stderr.trimEnd());
    }
    throw new Error(
      `${shown} failed (exit ${code}) in ${projectDir}.` +
      (frozen
        ? ` If package.json changed on purpose, run \`bun install\` there and commit the updated bun.lock.`
        : ``),
    );
  }
  if (opts.quiet) {
    const summary = /(\d+)\s+packages?\s+installed(?:\s+\[([\d.]+m?s)\])?/i.exec(stdout ?? "");
    logger.step(
      summary
        ? `installed ${summary[1]} package${summary[1] === "1" ? "" : "s"}${summary[2] ? ` in ${summary[2]}` : ""}`
        : `dependencies installed`,
    );
  }
  // Recomputed, not reused: the unfrozen first install WRITES bun.lock, so the
  // key taken before the spawn describes a state that no longer exists.
  // Stamping it would make the very next build think the project had drifted
  // and re-verify forever. (Caught by a test, not by reading.)
  writeInstallStamp(projectDir, installKey(projectDir));
}

/** `cargo build --release` for the chosen backend if its binary doesn't exist yet. */
export async function ensureRuntime(
  backend: BackendName,
  logger: Logger,
  flags: RuntimeFeatureFlags = {},
  opts: { quiet?: boolean; force?: boolean; projectDir?: string; exeName?: string } = {},
): Promise<string> {
  // `flags.staticPlugins` binaries are NOT generic across apps (each one has
  // one specific app's plugins compiled in), so they cannot share
  // runtimeBinaryPath's single workspace-wide location the way a dynamic
  // build's binary safely does — see distBinaryPath's own doc comment for
  // the full reasoning. `opts.projectDir` is required whenever
  // `flags.staticPlugins` is set; every other caller omits it and gets
  // exactly today's shared-path behavior.
  if (flags.staticPlugins && !opts.projectDir) {
    throw new Error(
      "ensureRuntime: flags.staticPlugins requires opts.projectDir — a static-plugins binary is " +
        "per-app and cannot be resolved from the shared workspace target directory alone.",
    );
  }

  // Search dist before release (resolveBackendBinary's order) rather than
  // hardcoding runtimeBinaryPath's "release" default — a dist-only build
  // (no release binary at all) must still resolve to the binary that
  // actually exists, not a path nothing was ever written to.
  //
  // `opts.force` skips this reuse check entirely. Needed for
  // `flags.staticPlugins`: unlike every other flag here, WHICH plugins are
  // linked in is per-app and can change between builds with no change to
  // this crate's own Rust source or Cargo features — the one thing this
  // cache key (backend + feature list, implicitly, via cargo's own
  // incremental state) does not capture at all. A cached binary from an
  // earlier plugin set on this same app would otherwise be silently reused.
  const existing = opts.force ? null : resolveBackendBinary(backend, opts.projectDir, opts.exeName);
  if (existing) return existing;
  // The shared path is still where CARGO itself writes and caches — that
  // part is unaffected either way, and reusing it keeps cargo's own
  // incremental-compile state warm between static-plugins builds too. What
  // changes is what this function RETURNS: for a static build, the shared
  // path is copied into the app's own dist/ (see below) and that copy,
  // never the shared path, is the answer callers get and everything
  // downstream (bundle.command.ts) resolves against.
  //
  // Cargo profile: `flags.staticPlugins` is the same signal build.command.ts
  // already sets from `--release` — this is a SHIPPING build, so it uses the
  // workspace's `dist` profile (opt-level "z", fat LTO, one codegen unit,
  // stripped — see .tools/orchestration/bazel/cargo/Cargo.toml's own
  // comment: "what //products/carbon:mini and the release workflow use, and
  // what every published benchmark number describes"), not `release`
  // (opt-level 3, thin LTO, unstripped — tuned for fast local iteration, not
  // for what ships). Measured on carbon-mini with no optional features: the
  // `release` profile produced a 15.7 MiB binary; `dist` produced 10.5 MiB
  // for the exact same code — a 33% difference from the profile alone, and
  // this function shipped `release` unconditionally until now. `run`/`dev`
  // never set `staticPlugins`, so their `ensureRuntime` calls are completely
  // unaffected — they keep using `release` for fast rebuilds, same as
  // before. `BINARY_PROFILES` (used by `resolveBackendBinary`'s shared-path
  // fallback) already searches "dist" before "release", so this fix needed
  // no change on the resolution side — only the build side was ever wrong.
  const cargoProfile = flags.staticPlugins ? "dist" : "release";
  const exe = runtimeBinaryPath(backend, cargoProfile);

  logger.step(`compiling native runtime for ${backend} (first run only — this can take a few minutes)…`);
  const dir = runtimeCargoDir(backend);
  // mini and blitz are two `[[bin]]` targets in one package with no default
  // features (see carbon/runtime/Cargo.toml) — both --bin and --features
  // must be explicit, or cargo has no runnable target to select.
  const cargoArgs = [
    "build", "--profile", cargoProfile,
    "--bin", `carbon-${backend}`,
    "--no-default-features",
    "--features", backendCargoFeatures(backend, flags),
  ];
  // Cargo's default target directory is beside the workspace manifest
  // (.tools/orchestration/bazel/cargo/target). TARGET_DIR says .local/rust, and the Bazel cargo
  // rules set CARGO_TARGET_DIR to match. Without this the CLI builds
  // successfully and then fails to find what it just built.
  const cargoEnv = { ...process.env, CARGO_TARGET_DIR: TARGET_DIR };

  // Quiet mode pipes cargo's own (very verbose, per-crate) build output
  // instead of letting it stream to the terminal — none of it is useful on a
  // successful build. On failure the full output is dumped verbatim before
  // throwing, so a real compile error is never harder to see than before.
  const stdio = opts.quiet ? "pipe" : "inherit";
  const { code, stdout, stderr } = process.platform === "win32"
    ? await spawnRun(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          // `-EncodedCommand` (base64 UTF-16LE), NOT `-Command` with a raw
          // string. Found and fixed while testing static-plugins release
          // builds for real (a real cargo compile, not a cache hit — the
          // common case this pipeline hits every day, since the runtime
          // binary is normally already built): NodeProcessRunner's Windows
          // `shell:true` path quotes every argument with CMD.EXE's `""`
          // convention (doubling an embedded `"`) before joining them with
          // spaces for `cmd.exe /c`. That convention is right for cmd.exe's
          // OWN tokenizer but wrong for how a child process's argv is
          // actually parsed (the CommandLineToArgvW convention `\"` most
          // Win32/.NET programs — powershell.exe included — use), so a
          // `-Command` value containing its own `"..."` (this one always
          // does, quoting activate-msvc.ps1's path) came out corrupted:
          // PowerShell then failed parsing ITS OWN script text with "The
          // string is missing the terminator". Confirmed by reproducing
          // with `flags.staticPlugins` OFF and nothing plugin-related
          // involved — genuinely pre-existing, not introduced by this
          // feature. `-EncodedCommand`'s value is pure base64 — no spaces,
          // quotes, or shell metacharacters at all — so it passes through
          // every quoting layer (cmd.exe's join, PowerShell's own argv
          // parse) completely unmolested regardless of what the decoded
          // script text contains.
          "-EncodedCommand",
          Buffer.from(
            `. "${join(SCRIPTS_DIR, "automation", "bootstrap", "activate-msvc.ps1")}"; cargo ${cargoArgs.join(" ")}`,
            "utf16le",
          ).toString("base64"),
        ],
        { cwd: dir, env: cargoEnv, stdio },
      )
    : await spawnRun("cargo", cargoArgs, { cwd: dir, env: cargoEnv, stdio });
  if (code !== 0) {
    if (opts.quiet) {
      if (stdout) logger.raw(stdout.trimEnd());
      if (stderr) logger.raw(stderr.trimEnd());
    }
    throw new Error(`cargo build for ${backend} failed (exit ${code})`);
  }
  if (!existsSync(exe)) {
    throw new Error(`cargo finished but binary not at expected path: ${exe}`);
  }
  if (opts.quiet) logger.step(`runtime binary built`);

  if (flags.staticPlugins) {
    // Durable, per-app record of what THIS app ships — see distBinaryPath's
    // doc comment. Copied (not moved): the shared path stays intact as
    // cargo's own build/cache location for the next invocation. Named
    // after `opts.exeName` (the app's own `[app] name`, sanitized by
    // distBinaryPath) when given, so what a user finds in dist/ isn't
    // stuck reading `carbon-mini.exe` regardless of what they're building.
    const dist = distBinaryPath(opts.projectDir!, backend, opts.exeName);
    mkdirSync(join(opts.projectDir!, "dist"), { recursive: true });
    copyFileSync(exe, dist);
    return dist;
  }

  return exe;
}

/**
 * Run our bun-build + Babel pipeline. Replaces Vite for the carbon-mini
 * backend — same plugin chain (carbon-transforms + carbon-tailwind +
 * babel-preset-solid universal), without Vite + Rollup's config-load and
 * graph-build overhead. See build-pipeline.ts for the gory bits.
 */
/** Same detection BunBundler.ts does internally, needed here one step
 *  earlier to decide whether to route through the split build at all. */
function isReactProject(projectDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "react" in deps && !("solid-js" in deps);
  } catch {
    return false;
  }
}

async function buildMiniBundle(
  projectDir: string,
  logger: Logger,
  opts: { noBabelCache?: boolean; wrapIife?: boolean; reactDev?: boolean } = {},
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
  // React's dev/HMR build (opts.reactDev — true whenever `carbon dev` builds
  // a React project, independent of whether bytecode/wrapIife is on; see
  // BunBabelBuildOptions.reactDev's doc comment for why this can't reuse
  // wrapIife) needs the split: React Fast Refresh (see
  // solutions/interface/renderer/react/runtime/refresh.ts) requires
  // react/react-refresh's own module state to survive a reload, which only
  // holds when they're NOT part of what gets re-evaluated on every save —
  // exactly what the split's vendor.js is for. Solid and production builds
  // are unaffected: CARBON_SPLIT=1 still opts any of them in manually, same
  // as before.
  const useSplit = splitEnabled() || (!!opts.reactDev && isReactProject(projectDir));
  if (useSplit) {
    // Vendor/app split: node_modules → dist/vendor.js (once), app → bundle.js.
    logger.step(`building ${entry} → dist/{vendor,bundle}.js (split)…`);
    await buildBundleSplit({
      projectDir,
      entry,
      outFile: "dist/bundle.js",
      solid: { generate: "universal", moduleName: "@carbon/mini-solid" },
      noBabelCache: opts.noBabelCache,
      wrapIife: opts.wrapIife,
      reactDev: opts.reactDev,
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
    reactDev: opts.reactDev,
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
  // Separate from wrapIife on purpose — see BunBabelBuildOptions.reactDev's
  // doc comment. `carbon dev` on the mini backend runs with bytecode OFF, so
  // wrapIife is false for exactly the build this flag needs to stay true for.
  const reactDev = !!opts.dev;
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
    await buildMiniBundle(projectDir, logger, { noBabelCache: opts.noBabelCache, wrapIife, reactDev });
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
