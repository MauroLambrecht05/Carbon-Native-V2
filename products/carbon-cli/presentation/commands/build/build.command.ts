import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
// `carbon build` — same as `run` minus the spawn. Ensures everything is
// built so the user can copy dist/ + the runtime binary to a deploy target.

import { resolve, join } from "node:path";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { supportsMiniBytecode, PRODUCTS_DIR } from "@carbon/workspace";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { pluginUseCases, PluginError } from "@carbon/lifecycle";
import { StatusLine } from "../../ui/status-line.ts";
import { printBanner } from "../../ui/brand.ts";

// Same SDK/standard-plugins roots plugin.command.ts resolves against — see
// that file's own comment for why @carbon/lifecycle cannot name these
// itself (a solution may not name a path inside a product).
const SDK_ROOT = join(PRODUCTS_DIR, "carbon-ext");
const STANDARD_PLUGINS_ROOT = join(PRODUCTS_DIR, "carbon-sdk");

export async function buildCommand(rest: string[]): Promise<number> {
  let projectDir = process.cwd();
  let runtimeOverride: string | undefined;
  let force = false;
  let noBabelCache = false;
  let release = false;
  let verbose = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--runtime" || a === "-r") runtimeOverride = rest[++i];
    else if (a.startsWith("--runtime=")) runtimeOverride = a.slice("--runtime=".length);
    else if (a === "--force" || a === "--no-cache" || a === "-f") force = true;
    else if (a === "--no-babel-cache") noBabelCache = true;
    else if (a === "--release" || a === "--prod") release = true;
    else if (a === "--verbose" || a === "-V") verbose = true;
    // Resolve to absolute: a relative dir (`carbon build .`) otherwise reaches
    // Bun.build plugins as a relative path, which Bun rejects.
    else if (!a.startsWith("-")) projectDir = resolve(a);
  }

  // Quiet by default — see the matching block in dev.command.ts.
  if (!verbose && process.env["CARBON_NO_TIMING"] === undefined) {
    process.env["CARBON_NO_TIMING"] = "1";
  }

  // Release profile: smallest + fastest distributable. Drop console/debugger
  // (CARBON_RELEASE → Bun `drop`), force bytecode (skip the cold-start parse),
  // and always rebuild so the strip actually applies. The distributable is just
  // the runtime binary + dist/bundle.qbc.zst — the .js is the compile input
  // only and need not be shipped.
  if (release) {
    process.env.CARBON_RELEASE = "1";
    force = true;
  }

  const cfg = loadCarbonConfig(projectDir);
  const backend = runtimeOverride ?? cfg.runtime.backend;
  if (!isBackend(backend)) {
    log.error(`Unknown runtime: "${backend}". Valid: ${VALID_BACKENDS}.`);
    return 1;
  }

  printBanner("build");

  const status = new StatusLine(verbose);

  try {
    status.begin(`building ${cfg.app.name} (${backend})…`);
    await ensureNodeModules(projectDir, log, { quiet: !verbose });

    // Static-link every enabled plugin directly into the runtime binary —
    // release builds only; `carbon dev`/a plain `carbon build` never touch
    // this, and keep using the dynamic dlopen pipeline (SyncPluginsUseCase)
    // exactly as before. See StaticLinkPluginsUseCase's own header comment
    // for why this replaces per-plugin signing+staging rather than just
    // adding to it.
    if (release) {
      const { staticLink } = pluginUseCases(SDK_ROOT, STANDARD_PLUGINS_ROOT);
      const linked = await staticLink.execute(projectDir, { logger: log });
      log.step(
        linked.empty
          ? "no plugins enabled — linking an empty static-plugins runtime"
          : `statically linked ${linked.pluginCount} plugin(s)`,
      );
      // build.rs (products/carbon/build.rs) reads these to find the umbrella
      // static lib and link it into carbon-mini/carbon-blitz — see its own
      // "static-linked plugins" section for what happens if either is unset.
      process.env.CARBON_STATIC_PLUGINS_LIB_DIR = linked.libDir;
      process.env.CARBON_STATIC_PLUGINS_LIB_NAME = linked.libName;
    }

    // Static-plugins builds return a per-app dist/ path (see ensureRuntime's
    // and distBinaryPath's own comments) — NOT the shared workspace path
    // runtimeBinaryPath(backend) points at, which is why this return value
    // is captured and used for every report below rather than re-deriving
    // the path a second way.
    const runtimeExe = await ensureRuntime(backend, log, {
      // The manifest decides which optional subsystems get linked — see
      // backendCargoFeatures. Without this an app declaring `image = true`
      // gets a runtime that cannot decode images, silently.
      image: cfg.runtime.image,
      audio: cfg.runtime.audio,
      updater: cfg.updater?.enabled,
      staticPlugins: release,
    }, {
      quiet: !verbose,
      // See ensureRuntime's own comment on `force`: which plugins are
      // linked in is per-app and cargo's own cache has no way to notice it
      // changed, so a release build always recompiles rather than risking a
      // stale binary from an earlier plugin set on THIS app (distBinaryPath
      // is what protects against a DIFFERENT app's build clobbering it).
      force: release,
      projectDir,
    });
    await buildProject(projectDir, backend, log, {
      // Release forces bytecode regardless of carbon.toml so the shipped app
      // never pays the QuickJS source-parse at launch.
      bytecode: cfg.runtime.bytecode || release,
      force,
      noBabelCache,
    });
    status.succeed();
    log.success(`${c.bold(cfg.app.name)} build complete`);
    log.step(`runtime: ${c.dim(runtimeExe)}`);
    log.step(`bundle:  ${c.dim(`${projectDir}/dist`)}`);
    if (release && supportsMiniBytecode(backend)) {
      // Report the minimal distributable: runtime binary + bytecode bundle.
      const { existsSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const mb = (p: string) => (existsSync(p) ? (statSync(p).size / 1048576) : 0);
      const rt = runtimeExe;
      const qbc = join(projectDir, "dist", "bundle.qbc.zst");
      const total = mb(rt) + mb(qbc);
      log.success(
        `release distributable: ${total.toFixed(1)} MB ` +
        `(runtime ${mb(rt).toFixed(1)} MB + bundle ${mb(qbc).toFixed(1)} MB) — ` +
        `ship dist/bundle.qbc.zst (the .js is build-input only)`,
      );
    } else if (release) {
      log.warn(`${backend} does not support bytecode release artifacts yet - ship dist/bundle.js with the runtime`);
    }
    return 0;
  } catch (e: any) {
    status.fail(e.message ?? String(e));
    // AggregateError (Bun's bundler throws this) — the actual errors
    // are in .errors, not .stack/.cause.
    if (Array.isArray(e?.errors)) {
      for (const sub of e.errors) {
        const loc = sub?.position ?? sub?.location ?? null;
        const locStr = loc?.line ? ` (${loc.file ?? ""}:${loc.line}:${loc.column ?? 0})` : "";
        console.error(`  · ${sub?.name ?? ""}${locStr}: ${sub?.message ?? sub}`);
        if (sub?.stack && process.env.CARBON_DEBUG) console.error(sub.stack);
      }
    } else if (e?.stack) {
      console.error(e.stack);
    }
    return 1;
  }
}


// ── Command ─────────────────────────────────────────────────────────────────
// The implementation above is the ported V1 body, unchanged. This class is
// what the registry routes to: metadata lives beside the code it describes,
// so help and dispatch cannot drift from each other.

export class BuildCommand extends Command {
  readonly meta: CommandMeta = {
    name: "build",
    summary: "Build UI + shell + runtime, but don't launch",
    usage: "build [project-dir] [options]",
    flags: [
      { name: "runtime", short: "r", placeholder: "<name>", description: "Override the carbon.toml [runtime] backend" },
      { name: "release", boolean: true, description: "Build with the release profile" },
      { name: "verbose", short: "V", boolean: true, description: "Show every install/build/runtime step instead of the collapsed status line" },
    ],
    examples: ["carbon build", "carbon build ./path/to/app --runtime mini"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return buildCommand([...ctx.argv]);
  }
}

export default BuildCommand;
