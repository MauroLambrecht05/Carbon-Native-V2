import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
// `carbon dev` — fast iteration loop.
//
// v2 architecture (this file): true in-process HMR for the `mini` backend.
//   - Spawn carbon-mini once with --dev
//   - Watch every cache-tracked source file (same set as the build cache)
//   - On change: rebuild via the same buildProject() pipeline (cache miss).
//   - The carbon-mini runtime has its OWN bundle-file watcher (started by
//     the --dev flag) that detects the new dist/bundle.qbc.zst and re-evals
//     it in-process. Signal values stashed via createPersistentSignal()
//     survive the reload because the rquickjs context isn't dropped.
//   - On SIGINT: kill the runtime + exit
//
// Backends without --dev support (webview2, verso) fall back to the v1
// kill+respawn dance. Detection: HMR_BACKENDS set below. When a new
// runtime gains --dev support, add it to the set.

import { spawn, type ChildProcess } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { emitKeypressEvents, type Key } from "node:readline";
import { join, resolve } from "node:path";
import { computeCacheKey } from "@carbon/bundling";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { pluginUseCases } from "@carbon/lifecycle";
import { PRODUCTS_DIR } from "@carbon/workspace";
import { StatusLine } from "../../ui/status-line.ts";
import { printBanner, printReadySummary, printRebuildLine } from "../../ui/brand.ts";

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".carbon-cache", "target", ".git",
]);

/**
 * Backends that support --dev (in-process HMR). For these we spawn the
 * runtime exactly once and rely on its own bundle-file watcher to reload.
 * For others we fall back to the v1 kill+respawn loop.
 */
const HMR_BACKENDS: ReadonlySet<string> = new Set(["mini"]);

interface Args {
  projectDir: string;
  runtimeOverride?: string;
  /** Min ms between consecutive reloads (debounce noisy editors). */
  debounce: number;
  noBabelCache: boolean;
  /** Show every internal step (install/build/runtime output, timing
   *  breakdowns) instead of the collapsed status line + ready banner. */
  verbose: boolean;
}

function parseArgs(rest: string[]): Args {
  let projectDir = process.cwd();
  let runtimeOverride: string | undefined;
  let debounce = 50;
  let noBabelCache = false;
  let verbose = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--runtime" || a === "-r") runtimeOverride = rest[++i];
    else if (a.startsWith("--runtime=")) runtimeOverride = a.slice("--runtime=".length);
    else if (a === "--debounce") debounce = Number(rest[++i]);
    else if (a === "--no-babel-cache") noBabelCache = true;
    else if (a === "--verbose" || a === "-V") verbose = true;
    // Resolve to absolute: a relative dir (`carbon dev .`) otherwise reaches
    // Bun.build plugins as a relative path, which Bun rejects.
    else if (!a.startsWith("-")) projectDir = resolve(a);
  }
  return { projectDir, runtimeOverride, debounce, noBabelCache, verbose };
}

/**
 * Recursively-watch a directory tree on Windows. Node's fs.watch on Windows
 * with { recursive: true } does the right thing — single watcher per tree.
 * On Linux/macOS it sometimes lies; for v1 we accept the loss (most carbon
 * dev sessions are on the user's primary OS).
 */
function watchTree(
  root: string,
  onChange: (path: string) => void,
): () => void {
  const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const norm = String(filename).replace(/\\/g, "/");
    // Filter out build artifacts + dep manager noise.
    for (const skip of SKIP_DIRS) {
      if (norm.startsWith(skip + "/") || norm === skip) return;
    }
    onChange(norm);
  });
  return () => watcher.close();
}

export async function devCommand(rest: string[]): Promise<number> {
  const { projectDir, runtimeOverride, debounce, noBabelCache, verbose } = parseArgs(rest);

  const cfg = loadCarbonConfig(projectDir);
  const backend = runtimeOverride ?? cfg.runtime.backend;
  if (!isBackend(backend)) {
    log.error(`Unknown runtime: "${backend}". Valid: ${VALID_BACKENDS}.`);
    return 1;
  }

  // Quiet by default: the runtime's own [timing] phase trace (products/
  // carbon/presentation/timing/trace.rs) and buildProject's internal
  // `[timing] build.*` lines both already respect CARBON_NO_TIMING — this is
  // what turns them off for the collapsed status-line experience. --verbose
  // opts back into the full breakdown (and leaves any caller-set env alone).
  if (!verbose && process.env["CARBON_NO_TIMING"] === undefined) {
    process.env["CARBON_NO_TIMING"] = "1";
  }

  printBanner("dev server");

  const status = new StatusLine(verbose);

  try {
    // Wall-clock timing for everything before the runtime process exists —
    // cargo (ensureRuntime), the bundler, and zig (syncLocalPlugins) are all
    // cost the runtime's own [timing] phase trace never sees, because that
    // trace starts counting from ITS OWN process start. Read together (with
    // --verbose) the two cover the entire command-to-first-render path.
    const tPipelineStart = performance.now();
    let tStageLast = tPipelineStart;
    const stage = (name: string) => {
      if (!verbose) return;
      const now = performance.now();
      const delta = now - tStageLast;
      const total = now - tPipelineStart;
      tStageLast = now;
      log.info(
        c.dim(
          `[timing] stage=${name.padEnd(24)} +${delta.toFixed(0).padStart(6)}ms   total ${total.toFixed(0).padStart(7)}ms`,
        ),
      );
    };

    status.begin(`preparing ${cfg.app.name} (${backend})…`);

    await ensureNodeModules(projectDir, log, { quiet: !verbose });
    stage("node_modules");

    const exe = await ensureRuntime(backend, log, {
      // The manifest decides which optional subsystems get linked — see
      // backendCargoFeatures. Without this an app declaring `image = true`
      // gets a runtime that cannot decode images, silently.
      image: cfg.runtime.image,
      audio: cfg.runtime.audio,
      updater: cfg.updater?.enabled,
    }, { quiet: !verbose });
    // Huge delta here means cargo just compiled the runtime from scratch —
    // ensureRuntime's status text says so right before that happens ("first
    // run only"). A near-zero delta means the binary was already there.
    stage("runtime_binary");

    // Dev always builds plain .js (NOT bytecode), regardless of carbon.toml.
    // Measured: in the HMR loop bytecode is a net LOSS — the ~2 s compile +
    // the slower wrapped-bytecode re-eval together cost more than a plain .js
    // re-eval. The runtime's own IIFE wrapper makes .js re-eval HMR-safe. So
    // dev = fastest reload; production (carbon run/build) keeps bytecode for
    // fastest launch. dev:true tags the cache so a prior `carbon run` artifact
    // (bytecode) isn't reused, and buildProject clears any stale .qbc.zst so
    // the runtime loads the fresh .js.
    const DEV_BYTECODE = false;
    await buildProject(projectDir, backend, log, { bytecode: DEV_BYTECODE, noBabelCache, dev: true });
    stage("bundle");

    // Any plugin whose SOURCE lives in this app's own carbon/own/<name>/
    // builds and installs itself here — no separate `carbon plugin install` step.
    await syncLocalPlugins(projectDir);
    stage("plugins");

    let proc: ChildProcess | null = null;
    let pendingReload = false;
    let reloadInFlight = false;
    let lastReload = 0;
    const useHmr = HMR_BACKENDS.has(backend);
    // Track the cache key from the previous successful build. The watcher
    // fires for our own dist/ writes too — recomputing the cache key cheaply
    // tells us whether anything that affects the output actually changed.
    let lastKey = computeCacheKey(projectDir, backend, DEV_BYTECODE, true);

    const launch = () => {
      const args = useHmr ? [projectDir, "--dev"] : [projectDir];
      log.step(useHmr ? "launching runtime (in-process HMR enabled)…" : "launching runtime…");
      // CARBON_ALLOW_UNSIGNED_PLUGINS: `carbon dev` builds and installs an
      // app's own carbon/own/<name>/ source locally (SyncLocalPluginsUseCase),
      // with no manual sign step — that flow was never meant to require
      // Carbon's signing key, only `carbon run`'s and a distributed build's
      // ever should. See the matching comment in plugin_loader.rs's
      // load_one — this is the one place that env var gets set, deliberately
      // never in run.command.ts.
      proc = spawn(exe, args, {
        stdio: "inherit",
        env: { ...process.env, CARBON_ALLOW_UNSIGNED_PLUGINS: "1" },
      });
      proc.on("close", (code, sig) => {
        // If the user manually closed the window we'll exit cleanly here too,
        // unless we're in the middle of an intentional reload-respawn.
        if (!reloadInFlight) {
          log.info(`runtime exited (code=${code ?? "null"} sig=${sig ?? "null"})`);
          process.exit(code ?? 0);
        }
      });
    };

    const reload = async (opts: { force?: boolean } = {}) => {
      if (reloadInFlight) {
        pendingReload = true;
        return;
      }
      reloadInFlight = true;
      const now = Date.now();
      if (now - lastReload < debounce) {
        await new Promise((r) => setTimeout(r, debounce - (now - lastReload)));
      }
      lastReload = Date.now();

      // Cheap content-hash check: did anything that affects the build
      // actually change? If not, the watcher fired for a build artifact —
      // skip the rebuild + respawn. Skipped entirely for the 'r' hotkey
      // (opts.force) — pressing it is a request to rebuild regardless of
      // whether anything on disk actually changed.
      const currentKey = computeCacheKey(projectDir, backend, DEV_BYTECODE, true);
      if (!opts.force && currentKey === lastKey) {
        reloadInFlight = false;
        return;
      }
      lastKey = currentKey;

      status.begin("rebuilding…");
      const tBuildStart = performance.now();
      try {
        await buildProject(projectDir, backend, log, {
          bytecode: DEV_BYTECODE,
          force: true, // skip the cache check inside buildProject
          noBabelCache,
          dev: true,
        });
        // A source change under carbon/own/<name>/ hits the same watcher as
        // any other file (SKIP_DIRS does not exclude it), so a rebuild here
        // also rebuilds+reinstalls a local plugin whose Zig source changed.
        await syncLocalPlugins(projectDir);
      } catch (e: any) {
        status.fail(`build failed: ${e.message ?? e}`);
        reloadInFlight = false;
        return;
      }
      const tBuildMs = performance.now() - tBuildStart;
      status.succeed();
      printRebuildLine(tBuildMs, { hmr: useHmr });

      // In-process HMR path: the runtime's own bundle-file watcher detects
      // the new artifact and re-evals it — we don't touch `proc`. Total
      // perceived latency = build time + ~100 ms watcher poll + ~50 ms
      // settle + actual eval (~5-15 ms typical). Backends without --dev
      // support get the legacy kill + respawn instead.
      if (!useHmr) {
        if (proc && !proc.killed) {
          proc.kill();
          await new Promise((resolve) => {
            if (!proc) { resolve(undefined); return; }
            proc.once("close", () => resolve(undefined));
          });
        }
        launch();
      }
      reloadInFlight = false;

      if (pendingReload) {
        pendingReload = false;
        // Coalesce one more pass for changes that arrived during rebuild.
        setTimeout(() => reload(), 50);
      }
    };

    // Start the watcher BEFORE the first launch so we don't miss edits
    // that happen during initial build.
    const stopWatcher = watchTree(projectDir, (path) => {
      // Heuristic: ignore obvious build outputs even though SKIP_DIRS catches dist/.
      if (path.endsWith(".carbon-cache.json")) return;
      reload();
    });

    launch();
    stage("spawn");
    if (verbose) {
      log.info(
        c.dim(
          "[timing] — carbon-mini's own [timing] phase trace continues from here (its own process start) —",
        ),
      );
    }

    status.succeed();
    printReadySummary({
      appName: cfg.app.name,
      version: cfg.app.version,
      backend,
      elapsedMs: performance.now() - tPipelineStart,
      hmr: useHmr,
      hotkeys: `${c.bold("q")} quit  ·  ${c.bold("r")} rebuild`,
    });

    // Wait forever; SIGINT cleanup below.
    const onSig = () => {
      log.info(c.dim("shutting down dev server…"));
      stopHotkeys();
      stopWatcher();
      reloadInFlight = true; // suppress the "runtime exited" auto-exit
      try { proc?.kill(); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    // 'q'/'r' hotkeys — TTY only. Raw mode intercepts the terminal's own
    // Ctrl+C→SIGINT translation, so Ctrl+C is handled right here too rather
    // than left to the "SIGINT" listener above once this is active. Safe to
    // run alongside the runtime child's inherited stdio: carbon-mini is a
    // windowed GUI app that gets keyboard input from the OS window, not from
    // console stdin, so it never reads from the stream this puts in raw mode.
    let stopHotkeys = () => {};
    if (process.stdin.isTTY) {
      try {
        emitKeypressEvents(process.stdin);
        const wasRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const onKeypress = (_str: string, key: Key | undefined) => {
          if (key?.ctrl && key.name === "c") { onSig(); return; }
          if (key?.name === "q") { onSig(); return; }
          if (key?.name === "r") { void reload({ force: true }); return; }
        };
        process.stdin.on("keypress", onKeypress);
        stopHotkeys = () => {
          process.stdin.off("keypress", onKeypress);
          try { process.stdin.setRawMode(wasRaw ?? false); } catch { /* not a TTY */ }
        };
      } catch {
        // Raw mode unsupported on this stream — Ctrl+C still works via the
        // SIGINT listener above, there's just no 'q'/'r' shortcut.
      }
    }

    // Block forever; SIGINT (or 'q') exits via process.exit above.
    return await new Promise<number>(() => {});
  } catch (e: any) {
    // status.fail() is a no-op once succeed() has already fired (past the
    // "block forever" point above, every error is caught locally inside
    // reload() instead) — safe to call unconditionally here.
    status.fail(e.message ?? String(e));
    return 1;
  }
}


/**
 * Build + install every plugin whose source lives in this app's own
 * carbon/own/<name>/, so the app project is the single source of truth and
 * there is nothing to remember to run separately.
 *
 * A build failure here is fatal — a plugin this app owns the source of
 * failing to compile is this app's own build breaking, not a missing
 * optional feature.
 *
 * Debug build (the default `release: false`) — same reasoning as
 * DEV_BYTECODE above: wall-clock rebuild time matters here, the plugin
 * binary's own runtime speed does not.
 */
async function syncLocalPlugins(projectDir: string): Promise<void> {
  const { synced } = await pluginUseCases(join(PRODUCTS_DIR, "carbon-ext")).syncLocal.execute(
    projectDir,
    { logger: log },
  );
  for (const plugin of synced) {
    log.step(c.dim(`plugin ${plugin.name}: built + installed from ./carbon/own/${plugin.name}`));
  }
}

// ── Command ─────────────────────────────────────────────────────────────────
// The implementation above is the ported V1 body, unchanged. This class is
// what the registry routes to: metadata lives beside the code it describes,
// so help and dispatch cannot drift from each other.

export class DevCommand extends Command {
  readonly meta: CommandMeta = {
    name: "dev",
    summary: "Watch source, auto-rebuild + auto-relaunch on change",
    usage: "dev [project-dir] [options]",
    flags: [
      { name: "runtime", short: "r", placeholder: "<name>", description: "Override the carbon.toml [runtime] backend" },
      { name: "verbose", short: "V", boolean: true, description: "Show every install/build/runtime step instead of the collapsed status line" },
    ],
    examples: ["carbon dev", "carbon dev ./my-app", "carbon dev --verbose"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return devCommand([...ctx.argv]);
  }
}

export default DevCommand;
