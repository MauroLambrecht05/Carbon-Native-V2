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
import { join, resolve } from "node:path";
import { computeCacheKey } from "@carbon/bundling";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { pluginUseCases } from "@carbon/lifecycle";
import { PRODUCTS_DIR } from "@carbon/workspace";

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
}

function parseArgs(rest: string[]): Args {
  let projectDir = process.cwd();
  let runtimeOverride: string | undefined;
  let debounce = 50;
  let noBabelCache = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--runtime" || a === "-r") runtimeOverride = rest[++i];
    else if (a.startsWith("--runtime=")) runtimeOverride = a.slice("--runtime=".length);
    else if (a === "--debounce") debounce = Number(rest[++i]);
    else if (a === "--no-babel-cache") noBabelCache = true;
    // Resolve to absolute: a relative dir (`carbon dev .`) otherwise reaches
    // Bun.build plugins as a relative path, which Bun rejects.
    else if (!a.startsWith("-")) projectDir = resolve(a);
  }
  return { projectDir, runtimeOverride, debounce, noBabelCache };
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
  const { projectDir, runtimeOverride, debounce, noBabelCache } = parseArgs(rest);

  const cfg = loadCarbonConfig(projectDir);
  const backend = runtimeOverride ?? cfg.runtime.backend;
  if (!isBackend(backend)) {
    log.error(`Unknown runtime: "${backend}". Valid: ${VALID_BACKENDS}.`);
    return 1;
  }

  log.info(
    `${c.bold("carbon dev")} — app ${c.cyan(cfg.app.name)} on ${c.magenta(backend)} backend`,
  );

  try {
    // Wall-clock timing for everything before the runtime process exists —
    // cargo (ensureRuntime), the bundler, and zig (syncLocalPlugins) are all
    // cost the runtime's own [timing] phase trace (in
    // products/carbon/presentation/timing/trace.rs, printed by carbon-mini
    // itself, ending in first_paint_visible) never sees, because that trace
    // starts counting from ITS OWN process start. Same `[timing]` prefix and
    // column layout on purpose: read one after the other, the two traces
    // cover the entire command-to-first-render path with no gap.
    const tPipelineStart = performance.now();
    let tStageLast = tPipelineStart;
    const stage = (name: string) => {
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

    await ensureNodeModules(projectDir, log);
    stage("node_modules");

    const exe = await ensureRuntime(backend, log, {
      // The manifest decides which optional subsystems get linked — see
      // backendCargoFeatures. Without this an app declaring `image = true`
      // gets a runtime that cannot decode images, silently.
      image: cfg.runtime.image,
      audio: cfg.runtime.audio,
      updater: cfg.updater?.enabled,
    });
    // Huge delta here means cargo just compiled the runtime from scratch —
    // ensureRuntime logs "runtime binary not built — running cargo build
    // --release" right before that happens, so the two lines together say
    // which branch this run took. A near-zero delta means the binary was
    // already there and this stage was just an fs.existsSync check.
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

    // Any plugin whose SOURCE lives in this app's own plugins/<name>/ builds
    // and installs itself here — no separate `carbon plugin install` step.
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
      log.info(c.dim(useHmr ? "launching runtime (in-process HMR enabled)…" : "launching runtime…"));
      // CARBON_ALLOW_UNSIGNED_PLUGINS: `carbon dev` builds and installs an
      // app's own plugins/<name>/ source locally (SyncLocalPluginsUseCase),
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

    const reload = async () => {
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
      // skip the rebuild + respawn.
      const currentKey = computeCacheKey(projectDir, backend, DEV_BYTECODE, true);
      if (currentKey === lastKey) {
        reloadInFlight = false;
        return;
      }
      lastKey = currentKey;

      log.info(c.dim("source change detected — rebuilding…"));
      const tBuildStart = performance.now();
      try {
        await buildProject(projectDir, backend, log, {
          bytecode: DEV_BYTECODE,
          force: true, // skip the cache check inside buildProject
          noBabelCache,
          dev: true,
        });
        // A source change under plugins/<name>/ hits the same watcher as any
        // other file (SKIP_DIRS does not exclude it), so a rebuild here also
        // rebuilds+reinstalls a local plugin whose Zig source changed.
        await syncLocalPlugins(projectDir);
      } catch (e: any) {
        log.error(`build failed: ${e.message ?? e}`);
        reloadInFlight = false;
        return;
      }
      const tBuildMs = performance.now() - tBuildStart;

      if (useHmr) {
        // In-process HMR path: the runtime's own bundle-file watcher
        // detects the new artifact and re-evals it. We don't touch `proc`.
        // Total perceived latency = build time + ~100 ms watcher poll +
        // ~50 ms settle + actual eval (~5-15 ms typical).
        log.info(
          c.dim(`rebuilt in ${tBuildMs.toFixed(0)} ms — runtime will hot-reload`),
        );
      } else {
        // Legacy kill + respawn for backends without --dev.
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
    log.info(
      c.dim(
        "[timing] — carbon-mini's own [timing] phase trace continues from here (its own process start) —",
      ),
    );

    // Wait forever; SIGINT cleanup below.
    const onSig = () => {
      log.info(c.dim("shutting down dev server…"));
      stopWatcher();
      reloadInFlight = true; // suppress the "runtime exited" auto-exit
      try { proc?.kill(); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    // Block forever; SIGINT exits via process.exit above.
    return await new Promise<number>(() => {});
  } catch (e: any) {
    log.error(e.message ?? String(e));
    return 1;
  }
}


/**
 * Build + install every plugin whose source lives in this app's own
 * plugins/<name>/, so the app project is the single source of truth and
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
  );
  for (const plugin of synced) {
    log.step(c.dim(`plugin ${plugin.name}: built + installed from ./plugins/${plugin.name}`));
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
    ],
    examples: ["carbon dev", "carbon dev ./my-app"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return devCommand([...ctx.argv]);
  }
}

export default DevCommand;
