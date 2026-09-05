import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
// `carbon run` — build everything that needs building, then launch the runtime.
// One command instead of `bun install && bun run vite:build && bun run shell:build && cargo build --release && ./carbon-runtime`.

import { join, resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { start, tryDaemonRun } from "@carbon/process";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { NoHostAppError, pluginUseCases } from "@carbon/lifecycle";
import { PRODUCTS_DIR, TARGET_DIR } from "@carbon/workspace";
import { StatusLine } from "../../ui/status-line.ts";
import { printBanner, printReadySummary } from "../../ui/brand.ts";

interface Args {
  projectDir: string;
  runtimeOverride?: string;
  force: boolean;
  noBabelCache: boolean;
  verbose: boolean;
  clean: boolean;
  debug: boolean;
}

function parseArgs(rest: string[]): Args {
  let projectDir = process.cwd();
  let runtimeOverride: string | undefined;
  let force = false;
  let noBabelCache = false;
  let verbose = false;
  let clean = false;
  let debug = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--runtime" || a === "-r") {
      runtimeOverride = rest[++i];
    } else if (a.startsWith("--runtime=")) {
      runtimeOverride = a.slice("--runtime=".length);
    } else if (a === "--force" || a === "--no-cache" || a === "-f") {
      force = true;
    } else if (a === "--no-babel-cache") {
      noBabelCache = true;
    } else if (a === "--verbose" || a === "-V") {
      verbose = true;
    } else if (a === "--clean") {
      clean = true;
    } else if (a === "--debug" || a === "-d") {
      debug = true;
    } else if (!a.startsWith("-")) {
      // Resolve to an absolute path: a relative dir (e.g. `carbon run .`)
      // otherwise flows into Bun.build plugins as a relative `path`, which
      // Bun rejects ("path must be absolute when the namespace is file").
      projectDir = resolve(a);
    }
  }
  return { projectDir, runtimeOverride, force, noBabelCache, verbose, clean, debug };
}

/**
 * Wipe every generated/fetched artifact under `projectDir` — node_modules,
 * the build cache (dist/, which also holds .carbon-cache.json), the Babel
 * transform cache (.carbon-cache/), and every staged plugin binary
 * (carbon/bin/) — so the pipeline below reinstalls and rebuilds all of it
 * from scratch. `carbon.toml` and `carbon/manifest.toml` are untouched:
 * they're the human/tool-authored source of truth, not cache.
 *
 * Vendor plugin SOURCE (carbon/plugins/vendor/<name>/carbon-plugin.toml) is
 * also left alone — it's cheap, tracked metadata, not a build artifact, and
 * syncPlugins already re-fetches it if missing. Only the compiled/staged
 * output (carbon/bin/) actually needs wiping to force a real re-fetch.
 *
 * `--clean` means clean — node_modules included, unconditionally, even
 * though a fresh install is the most expensive single step here (measured:
 * ~10.5s on this machine, all link/copy time against an already-fully-cached
 * dependency set, not a network fetch). `ensureNodeModules`'s own content-hash
 * staleness check (InstallState.ts) is a SEPARATE, faster mechanism for the
 * common case where nothing asked for a clean rebuild — it is not a
 * substitute for what `--clean` promises: a verified rebuild with nothing
 * left over from before, node_modules included. Skipping it here would make
 * `--clean` a partial clean that still trusts old installed state.
 */
function cleanAll(projectDir: string): void {
  const targets = [
    join(projectDir, "node_modules"),
    join(projectDir, "dist"),
    join(projectDir, ".carbon-cache"),
    join(projectDir, "carbon", "bin"),
  ];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    log.step(c.dim(`clean: removing ${dir}`));
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCommand(rest: string[]): Promise<number> {
  const { projectDir, runtimeOverride, force, noBabelCache, verbose, clean, debug } = parseArgs(rest);

  // Before loadCarbonConfig: carbon.toml itself is never touched by clean,
  // but node_modules/dist/carbon/bin need to be gone before anything below
  // (ensureNodeModules, syncPlugins, buildProject) runs, or those steps see
  // stale-but-present artifacts and skip work clean was asked to force.
  if (clean) cleanAll(projectDir);

  const cfg = loadCarbonConfig(projectDir);
  const backend = runtimeOverride ?? cfg.runtime.backend;
  if (!isBackend(backend)) {
    log.error(`Unknown runtime: "${backend}". Valid: ${VALID_BACKENDS}.`);
    return 1;
  }

  // Quiet by default — see the matching block in dev.command.ts.
  if (!verbose && process.env["CARBON_NO_TIMING"] === undefined) {
    process.env["CARBON_NO_TIMING"] = "1";
  }

  // --debug: the runtime's own console.log/info/debug output (scene.rs's
  // console shim) and its plugin-loader trace (plugin_loader.rs) are both
  // gated behind CARBON_MINI_DEBUG so a normal run stays quiet — apps tend
  // to log a lot. console.warn/console.error and plugin load FAILURES
  // already print unconditionally, so --debug only adds the routine trace,
  // not the errors this command's own error handling already surfaces.
  // Forwarded via process.env rather than a spawn `env:` override so it
  // survives being inherited (start() defaults to inheriting the parent's
  // env) without disturbing anything else already inherited.
  if (debug && process.env["CARBON_MINI_DEBUG"] === undefined) {
    process.env["CARBON_MINI_DEBUG"] = "1";
  }

  printBanner("run");

  const status = new StatusLine(verbose);

  try {
    // Wall-clock timing for everything before the runtime process exists —
    // see the matching block in dev.command.ts for why. Read alongside
    // carbon-mini's own [timing] phase trace (products/carbon/presentation/
    // timing/trace.rs, ending in first_paint_visible), this covers the whole
    // command-to-first-render path.
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
      network: cfg.runtime.network,
      svg: cfg.runtime.svg,
    }, {
      quiet: !verbose,
      // `force` used to reach buildProject's JS bundle cache only —
      // ensureRuntime's own reuse check (any existing binary at
      // TARGET_DIR/{dist,release}/carbon-<backend>, regardless of how old)
      // ignored it entirely. So editing the Rust runtime itself and running
      // `carbon run --force` still silently launched yesterday's binary —
      // no error, no staleness warning, just old behavior with no visible
      // sign anything was skipped. `--force`/`--no-cache` says "rebuild
      // everything," and the compiled runtime is part of "everything."
      force,
    });
    // Huge delta here means cargo just compiled the runtime from scratch —
    // ensureRuntime's status text says so right before that happens ("first
    // run only"). Near-zero means the binary already existed.
    stage("runtime_binary");

    // Every plugin carbon/manifest.toml declares is brought up to date here:
    // a missing vendor artifact is auto-fetched + signed, then `zig build`
    // runs once inside carbon/ — building every local plugin and staging
    // everything into carbon/bin/<os>/<arch>/. No separate `carbon plugin
    // install`/`add` step, on this machine or any other.
    //
    // Before buildProject, not after: the bundler's discoverLocalManifests
    // (solutions/integrations/bundler/vite) reads each plugin's own
    // carbon-plugin.toml to resolve `import ... from "carbon:*"` — on a
    // fresh clone (manifest.toml committed, the vendor artifact/manifest
    // gitignored and not yet fetched) that file does not exist until THIS
    // step's auto-heal writes it. Bundling first would fail to resolve the
    // import on exactly the machine auto-heal exists for.
    await syncPlugins(projectDir);
    stage("plugins");

    await buildProject(projectDir, backend, log, {
      bytecode: cfg.runtime.bytecode,
      force,
      noBabelCache,
    });
    stage("bundle");

    // Plugins, before the window rather than after. Everything reported here
    // the runtime would also report — as `[carbon-plugin] FAILED to load ...`
    // on a stderr stream nobody is watching, once the app is already up and
    // quietly missing a feature. An error is not fatal: the runtime skips a
    // plugin it cannot load and the app still runs, so this warns loudly and
    // carries on rather than refusing to launch something that works.
    preflightPlugins(projectDir);
    stage("preflight");

    log.step(`launching runtime (${exe})…`);

    // mini takes the project directory and resolves dist/bundle.js itself;
    // blitz takes the bundle file directly (see carbon/runtime/blitz.rs's
    // `bundle_arg`, which also derives app.css from the same path).
    //
    // This used to check `backend === "mini-blitz"` — blitz's directory name
    // before the runtime/ move — which normalizeBackend() already resolves
    // to "blitz" long before this file ever sees `backend`, so the check
    // could never be true and blitz always got the wrong argument.
    const runtimeArgs = backend === "blitz"
      ? [join(projectDir, "dist", "bundle.js")]
      : [projectDir];

    // Daemon first: a pre-warmed carbon-mini instance (products/carbon-launcher's
    // `daemon` subcommand) skips the OS process-creation cost the direct spawn
    // below still pays. Any daemon failure — unreachable, pool empty, stale —
    // falls straight through to that direct spawn; this is a pure optimization,
    // never a dependency of `carbon run` working at all. On a miss this also
    // warms the daemon in the background for next time (see
    // DaemonClient.ts's module doc for why that's a native `ensure-daemon`
    // call rather than spawning the daemon directly from here). One accepted
    // gap: Ctrl-C can't gracefully close a daemon-served window, since it
    // isn't attached to this CLI's console.
    const daemonCode = await tryDaemonRun({
      projectDir,
      backend,
      devMode: false,
      launcherExe: join(TARGET_DIR, "release", "carbon-launcher.exe"),
      onWindowVisible: () => {
        stage("window_visible");
        status.succeed();
        printReadySummary({
          appName: cfg.app.name,
          version: cfg.app.version,
          backend,
          elapsedMs: performance.now() - tPipelineStart,
        });
      },
    });
    if (daemonCode !== null) {
      return daemonCode;
    }

    // Plain, fully-inherited spawn — NOT startAndWaitForWindowVisible (see
    // NodeProcessRunner.ts's WINDOW_VISIBLE_MARKER doc comment for why that
    // was removed): on this machine, Bun's Windows child_process.spawn
    // allocated a brand-new visible console window for carbon-mini.exe the
    // moment ANY stdio stream was set to "pipe", even with the other two
    // left as "inherit" — confirmed directly via conhost.exe process counts.
    // "ready" prints immediately after spawn again, same as before that
    // feature — not a window-visible timestamp, but no stray console either.
    const child = start(exe, runtimeArgs);
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
    });

    // Forward Ctrl-C to the runtime so it can shut down cleanly.
    const onSig = () => {
      try { child.kill(); } catch {}
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    return await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
    });
  } catch (e: any) {
    status.fail(e.message ?? String(e));
    return 1;
  }
}


/**
 * Bring carbon/bin/<os>/<arch>/ up to date with what carbon/manifest.toml
 * declares — auto-fetching any missing vendor plugin, then building every
 * local one — so the app project is the single source of truth and there is
 * nothing to remember to run separately, on this machine or a teammate's.
 *
 * A failure here is fatal — unlike preflightPlugins below, which warns and
 * lets a load-time failure be the runtime's problem, a plugin this app's
 * manifest declares failing to build is this app's own build breaking, not
 * a missing optional feature.
 *
 * `release: true` — this is the artifact that ships, unlike `carbon dev`'s
 * fast Debug builds.
 */
async function syncPlugins(projectDir: string): Promise<void> {
  const { staged } = await pluginUseCases(
    join(PRODUCTS_DIR, "carbon-ext"),
    join(PRODUCTS_DIR, "carbon-sdk", "plugins"),
  ).sync.execute(projectDir, { release: true, logger: log });
  for (const file of staged) {
    log.step(c.dim(`plugin: staged ./carbon/bin/.../${file}`));
  }
}

/**
 * Report anything that will stop a declared plugin loading.
 *
 * Never throws: an app with no plugins, no carbon.toml above it, or a
 * malformed [plugins] table is not a reason to refuse to run. The runtime is
 * the enforcement point; this is the earlier, better-placed message.
 */
function preflightPlugins(projectDir: string): void {
  let result;
  try {
    // The preflight reads no templates, but the factory builds all the use
    // cases together, so it still wants the SDK root — see plugin.command.ts.
    result = pluginUseCases(join(PRODUCTS_DIR, "carbon-ext")).preflight.execute(projectDir);
  } catch (e) {
    // NoHostAppError means there is no carbon.toml, which `loadCarbonConfig`
    // above would already have failed on. Anything else here is a bug in the
    // preflight, and a bug in a warning must not take the app down.
    if (!(e instanceof NoHostAppError)) {
      log.warn(`plugin preflight skipped: ${(e as Error).message}`);
    }
    return;
  }

  if (result.checked === 0 || result.problems.length === 0) return;

  log.warn(`${result.problems.length} plugin problem(s) — the runtime will skip what it cannot load:`);
  for (const problem of result.problems) {
    log.raw(`  ${problem.severity === "error" ? c.red("×") : c.yellow("!")} ${c.bold(problem.plugin)}: ${problem.message}`);
    if (problem.fix) {
      for (const line of problem.fix.split("\n")) log.raw(`    ${c.dim(line)}`);
    }
  }
  log.raw("");
}

// ── Command ─────────────────────────────────────────────────────────────────
// The implementation above is the ported V1 body, unchanged. This class is
// what the registry routes to: metadata lives beside the code it describes,
// so help and dispatch cannot drift from each other.

export class RunCommand extends Command {
  readonly meta: CommandMeta = {
    name: "run",
    summary: "Build everything that needs building, then launch the app",
    usage: "run [project-dir] [options]",
    flags: [
      { name: "runtime", short: "r", placeholder: "<name>", description: "Override the carbon.toml [runtime] backend" },
      { name: "verbose", short: "V", boolean: true, description: "Show every install/build/runtime step instead of the collapsed status line" },
      { name: "clean", boolean: true, description: "Wipe node_modules, the build cache, and staged plugins first, then reinstall/rebuild everything from scratch" },
      { name: "debug", short: "d", boolean: true, description: "Show the runtime's console.log/info/debug output and plugin-load trace (sets CARBON_MINI_DEBUG=1). console.warn/error and load failures already print without this" },
    ],
    examples: ["carbon run", "carbon run --runtime mini", "carbon run --verbose", "carbon run --clean", "carbon run --debug"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return runCommand([...ctx.argv]);
  }
}

export default RunCommand;
