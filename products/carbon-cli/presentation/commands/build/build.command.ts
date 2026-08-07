import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
// `carbon build` — same as `run` minus the spawn. Ensures everything is
// built so the user can copy dist/ + the runtime binary to a deploy target.

import { resolve } from "node:path";
import { loadCarbonConfig } from "@carbon/workspace";
import { log, c } from "@carbon/logging";
import { runtimeBinaryPath, supportsMiniBytecode } from "@carbon/workspace";
import { isBackend, VALID_BACKENDS } from "@carbon/contracts/app/backend";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";

export async function buildCommand(rest: string[]): Promise<number> {
  let projectDir = process.cwd();
  let runtimeOverride: string | undefined;
  let force = false;
  let noBabelCache = false;
  let release = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--runtime" || a === "-r") runtimeOverride = rest[++i];
    else if (a.startsWith("--runtime=")) runtimeOverride = a.slice("--runtime=".length);
    else if (a === "--force" || a === "--no-cache" || a === "-f") force = true;
    else if (a === "--no-babel-cache") noBabelCache = true;
    else if (a === "--release" || a === "--prod") release = true;
    // Resolve to absolute: a relative dir (`carbon build .`) otherwise reaches
    // Bun.build plugins as a relative path, which Bun rejects.
    else if (!a.startsWith("-")) projectDir = resolve(a);
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

  log.info(
    `${c.bold("carbon build")} — app ${c.cyan(cfg.app.name)} on ${c.magenta(backend)} backend`,
  );

  try {
    await ensureNodeModules(projectDir, log);
    await ensureRuntime(backend, log);
    await buildProject(projectDir, backend, log, {
      // Release forces bytecode regardless of carbon.toml so the shipped app
      // never pays the QuickJS source-parse at launch.
      bytecode: cfg.runtime.bytecode || release,
      force,
      noBabelCache,
    });
    log.success(`build complete`);
    log.step(`runtime: ${c.dim(runtimeBinaryPath(backend))}`);
    log.step(`bundle:  ${c.dim(`${projectDir}/dist`)}`);
    if (release && supportsMiniBytecode(backend)) {
      // Report the minimal distributable: runtime binary + bytecode bundle.
      const { existsSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const mb = (p: string) => (existsSync(p) ? (statSync(p).size / 1048576) : 0);
      const rt = runtimeBinaryPath(backend);
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
    log.error(e.message ?? String(e));
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
    ],
    examples: ["carbon build", "carbon build ./path/to/app --runtime mini"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return buildCommand([...ctx.argv]);
  }
}

export default BuildCommand;
