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
