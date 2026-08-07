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
import { resolve } from "node:path";
import { computeCacheKey } from "@carbon/bundling";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";

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
    await ensureNodeModules(projectDir, log);
    const exe = await ensureRuntime(backend, log);

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
      proc = spawn(exe, args, { stdio: "inherit" });
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
