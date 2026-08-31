// `carbon build --release`'s plugin step — the static-linking counterpart to
// SyncPluginsUseCase's dlopen pipeline.
//
// ── WHY THIS EXISTS, NOT MORE OF SyncPluginsUseCase ─────────────────────────
// The dynamic pipeline's whole shape — stage a signed .dll into carbon/bin/,
// let the Rust loader verify+dlopen it at every launch — has nothing left to
// do once every enabled plugin is going to be compiled directly into the
// runtime binary. What this use case does instead:
//
//   1. VALIDATE — reuse PreflightPluginsUseCase (the exact same capability-
//      grant / unknown-point checks `carbon run` already runs) but ESCALATE
//      every error-severity problem into a thrown StaticLinkValidationError
//      instead of a warning. A plugin the dynamic loader would silently
//      skip at every launch (today's `[carbon-plugin] FAILED to load ...`,
//      easy to miss in a shipped app's stderr) instead fails the build
//      loudly, with the file to edit named — strictly better for a release
//      artifact, and free: the check already existed, this just changes
//      what happens when it fails.
//   2. GENERATE the umbrella (StaticUmbrellaGenerator.ts) for every enabled
//      plugin that passed validation.
//   3. BUILD it with `zig build`, producing the static lib
//      plugin_loader_static.rs's extern block expects to link against.
//
// No Ed25519 signing anywhere in this path, deliberately — see
// plugin_loader_static.rs's header comment for why that question doesn't
// apply once a plugin's source compiles into the same binary as the runtime
// in the same build.

import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import { MemoryLogger } from "@carbon/logging";
import type { ProcessRunner } from "@carbon/process";
import { extensionPoint } from "@carbon/contracts/plugin/extension-points";
import { parsePluginDeclaration } from "../../domain/entities/PluginDeclaration.ts";
import { readAppManifest } from "../../infrastructure/AppManifestCodec.ts";
import { NoHostAppError, StaticLinkValidationError, StaticUmbrellaBuildError } from "../../domain/errors/PluginError.ts";
import { ensureZig } from "../../infrastructure/ZigToolchain.ts";
import { generateUmbrella, type UmbrellaPlugin } from "../../infrastructure/StaticUmbrellaGenerator.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";
import type { PreflightPluginsUseCase } from "./PreflightPluginsUseCase.ts";

export interface StaticLinkOptions {
  readonly logger?: Logger;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface StaticLinkResult {
  /** Directory `zig build` produced the static lib into — pass as
   *  CARBON_STATIC_PLUGINS_LIB_DIR to the cargo invocation that follows. */
  readonly libDir: string;
  /** Always "carbon_plugins_umbrella" today — the generator's fixed
   *  `b.addLibrary` name — kept as a field rather than a shared constant so
   *  a caller never has to import the generator just to know it. */
  readonly libName: string;
  readonly pluginCount: number;
  /** True when no carbon/manifest.toml exists, or it declares zero enabled
   *  plugins — the umbrella is still generated+built (an EMPTY one, all 10
   *  points no-op) so build.rs always has something to link against,
   *  keeping `carbon build --release` uniform whether or not an app uses
   *  plugins at all. */
  readonly empty: boolean;
}

export class StaticLinkPluginsUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly processes: ProcessRunner,
    private readonly preflight: PreflightPluginsUseCase,
    private readonly sdkRoot: string,
    /** Where carbon-sdk lives — `products/carbon-sdk`. A vendor plugin's
     *  REAL source lives here, never in the app's own carbon/plugins/vendor/
     *  (which only ever gets the compiled artifact — see
     *  StaticUmbrellaGenerator's UmbrellaPlugin.mainZigPath doc comment).
     *  Same root AddStandardPluginUseCase already builds vendor plugins
     *  from for the dynamic path. */
    private readonly standardPluginsRoot: string,
  ) {}

  /**
   * @param projectDir the app being built.
   * @throws NoHostAppError, StaticLinkValidationError, ExclusivePointConflictError, StaticUmbrellaBuildError
   */
  async execute(projectDir: string, opts?: StaticLinkOptions): Promise<StaticLinkResult> {
    const logger = opts?.logger ?? new MemoryLogger();
    const host = this.workspace.findHostApp(projectDir);
    if (!host) throw new NoHostAppError(projectDir);

    // ── 1. Validate — same checks `carbon run` warns about, escalated ──────
    // "artifact-missing" is excluded on purpose: that problem kind means "no
    // .dll/.so/.dylib staged in carbon/bin/", which is irrelevant here — a
    // static release build compiles every enabled plugin fresh from source
    // and never reads carbon/bin/ at all. Every other error kind
    // (capability grants, unknown extension points) reads carbon-plugin.toml
    // instead, which applies identically to both pipelines.
    const preflightResult = this.preflight.execute(projectDir);
    const errors = preflightResult.problems.filter(
      (p) => p.severity === "error" && p.kind !== "artifact-missing",
    );
    if (errors.length > 0) {
      throw new StaticLinkValidationError(errors.map((e) => ({ plugin: e.plugin, message: e.message, fix: e.fix })));
    }

    // ── 2. Resolve the enabled-plugin list + each one's declared points ───
    const manifestPath = join(host, "carbon", "manifest.toml");
    const manifest = this.workspace.exists(manifestPath)
      ? readAppManifest(this.workspace.readFile(manifestPath))
      : { schema: 1, plugins: new Map() };

    const pluginsRoot = join(host, "carbon", "plugins");
    const plugins: UmbrellaPlugin[] = [];
    for (const [name, entry] of manifest.plugins) {
      if (!entry.enabled) continue;
      // The carbon-plugin.toml DECLARATION is readable from the app's own
      // copy either way (InstallPluginUseCase copies it for vendor plugins
      // too) — only the .zig SOURCE differs by origin, see mainZigPath below.
      const declPath = join(pluginsRoot, entry.source, name, "carbon-plugin.toml");
      // Preflight above already required this to exist and its capabilities
      // to be granted for every entry that reached this point — a missing
      // declaration here would mean preflight's own logic disagrees with
      // this read, which parsePluginDeclaration handles the same
      // best-effort way preflight does (an unreadable/absent manifest
      // yields no declared points, not a crash).
      const declaration = this.workspace.exists(declPath)
        ? parsePluginDeclaration(this.workspace.readFile(declPath))
        : { extensionPoints: [], requiredCapabilities: [], optionalCapabilities: [] };
      const points = declaration.extensionPoints.filter((id) => extensionPoint(id));
      const mainZigPath =
        entry.source === "vendor"
          ? join(this.standardPluginsRoot, name, "src", "main.zig")
          : join(pluginsRoot, "local", name, "src", "main.zig");
      plugins.push({ name, mainZigPath, points });
    }

    logger.step(
      plugins.length > 0
        ? `linking ${plugins.length} plugin(s) statically: ${plugins.map((p) => p.name).join(", ")}`
        : "no enabled plugins — building an empty static-plugins umbrella",
    );

    // ── 3. Generate + build the umbrella ────────────────────────────────────
    const umbrellaDir = join(host, "carbon", ".static-umbrella");
    this.workspace.createDirectory(umbrellaDir);
    const sdkComposition = join(this.sdkRoot, "composition");
    const files = generateUmbrella(umbrellaDir, sdkComposition, plugins, {
      platform: opts?.platform ?? process.platform,
      arch: opts?.arch ?? process.arch,
    });
    for (const [name, contents] of Object.entries(files)) {
      this.workspace.writeFile(join(umbrellaDir, name), contents);
    }

    const zig = await ensureZig(logger);
    const { code } = await this.processes.run(zig, ["build"], { cwd: umbrellaDir, stdio: "inherit" });
    if (code !== 0) throw new StaticUmbrellaBuildError(code);

    return {
      libDir: join(umbrellaDir, "zig-out", "lib"),
      libName: "carbon_plugins_umbrella",
      pluginCount: plugins.length,
      empty: plugins.length === 0,
    };
  }
}
