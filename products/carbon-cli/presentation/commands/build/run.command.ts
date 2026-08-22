import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
// `carbon run` — build everything that needs building, then launch the runtime.
// One command instead of `bun install && bun run vite:build && bun run shell:build && cargo build --release && ./carbon-runtime`.

import { join, resolve } from "node:path";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { start } from "@carbon/process";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { NoHostAppError, pluginUseCases } from "@carbon/lifecycle";
import { PRODUCTS_DIR } from "@carbon/workspace";

interface Args {
  projectDir: string;
  runtimeOverride?: string;
  force: boolean;
  noBabelCache: boolean;
}

function parseArgs(rest: string[]): Args {
  let projectDir = process.cwd();
  let runtimeOverride: string | undefined;
  let force = false;
  let noBabelCache = false;
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
    } else if (!a.startsWith("-")) {
      // Resolve to an absolute path: a relative dir (e.g. `carbon run .`)
      // otherwise flows into Bun.build plugins as a relative `path`, which
      // Bun rejects ("path must be absolute when the namespace is file").
      projectDir = resolve(a);
    }
  }
  return { projectDir, runtimeOverride, force, noBabelCache };
}

export async function runCommand(rest: string[]): Promise<number> {
  const { projectDir, runtimeOverride, force, noBabelCache } = parseArgs(rest);

  const cfg = loadCarbonConfig(projectDir);
  const backend = runtimeOverride ?? cfg.runtime.backend;
  if (!isBackend(backend)) {
    log.error(`Unknown runtime: "${backend}". Valid: ${VALID_BACKENDS}.`);
    return 1;
  }

  log.info(
    `${c.bold("carbon run")} — app ${c.cyan(cfg.app.name)} v${cfg.app.version} on ${c.magenta(backend)} backend`,
  );

  try {
    await ensureNodeModules(projectDir, log);
    const exe = await ensureRuntime(backend, log, {
      // The manifest decides which optional subsystems get linked — see
      // backendCargoFeatures. Without this an app declaring `image = true`
      // gets a runtime that cannot decode images, silently.
      image: cfg.runtime.image,
      audio: cfg.runtime.audio,
      updater: cfg.updater?.enabled,
    });
    await buildProject(projectDir, backend, log, {
      bytecode: cfg.runtime.bytecode,
      force,
      noBabelCache,
    });

    // Plugins, before the window rather than after. Everything reported here
    // the runtime would also report — as `[carbon-plugin] FAILED to load ...`
    // on a stderr stream nobody is watching, once the app is already up and
    // quietly missing a feature. An error is not fatal: the runtime skips a
    // plugin it cannot load and the app still runs, so this warns loudly and
    // carries on rather than refusing to launch something that works.
    preflightPlugins(projectDir);

    log.info(`launching runtime…`);
    log.step(c.dim(exe));
    log.raw("");

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
    const child = start(exe, runtimeArgs);

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
    log.error(e.message ?? String(e));
    return 1;
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
    ],
    examples: ["carbon run", "carbon run --runtime mini"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return runCommand([...ctx.argv]);
  }
}

export default RunCommand;
