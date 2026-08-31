// Bring an app's carbon/bin/<os>/<arch>/ tree up to date with what
// carbon/manifest.toml declares. Run by `carbon dev`/`carbon run` before
// every launch — no separate `carbon plugin install` step, and no separate
// `carbon plugin add` re-run on a teammate's machine or in CI either.
//
// Two responsibilities, in order:
//
//   1. AUTO-HEAL vendor plugins. carbon/manifest.toml is committed;
//      carbon/bin/<os>/<arch>/<name>.<ext> — the ONLY place a vendor
//      plugin's binary lives, InstallPluginUseCase writes it straight there
//      — is gitignored. A fresh clone declares a vendor plugin it has never
//      fetched — this notices and builds + signs it right then, the exact
//      flow `carbon plugin add` runs by hand (see AddStandardPluginUseCase,
//      the one place that logic lives, shared by both callers).
//   2. Shell `zig build --prefix .` once inside carbon/. That single command
//      builds every carbon/plugins/local/<name> and stages its artifact
//      into carbon/bin/<os>/<arch>/ (carbon/build.zig's own subprocess
//      orchestration — see its header comment for why a TypeScript-side
//      per-plugin build loop was replaced by this). A vendor plugin's
//      artifact is already sitting in carbon/bin/ by this point — step 1
//      put it there directly — so build.zig has nothing to do for it and
//      skips it entirely.
//
// `carbon/build.zig` not existing at all (no plugin has ever been added or
// scaffolded into this app) is a fast, silent no-op — most apps never grow
// a carbon/ directory.

import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import { MemoryLogger } from "@carbon/logging";
import type { ProcessRunner } from "@carbon/process";
import { readAppManifest } from "../../infrastructure/AppManifestCodec.ts";
import { hostArchName, hostExt, hostOsName } from "../../domain/value-objects/NativeTarget.ts";
import { ensureZig } from "../../infrastructure/ZigToolchain.ts";
import { hasDevSigningKey, signLocalPluginArtifact } from "../../infrastructure/PluginSigner.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";
import type { AddStandardPluginUseCase } from "./AddStandardPluginUseCase.ts";

export interface SyncPluginsOptions {
  /** See BuildPluginUseCase's own note: Debug by default for fast `carbon
   *  dev` rebuilds, Release for what `carbon run`/`build` actually ships. */
  readonly release?: boolean;
  readonly logger?: Logger;
}

export interface SyncPluginsResult {
  /** Filenames that landed in carbon/bin/<host-os>/<host-arch>/ after
   *  this run — empty when carbon/ doesn't exist yet, i.e. nothing to do. */
  readonly staged: readonly string[];
}

export type ResolveZig = (logger: Logger) => Promise<string>;

export class SyncPluginsUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly processes: ProcessRunner,
    private readonly addStandard: AddStandardPluginUseCase,
    private readonly resolveZig: ResolveZig = ensureZig,
  ) {}

  async execute(projectDir: string, opts?: SyncPluginsOptions): Promise<SyncPluginsResult> {
    const carbonDir = join(projectDir, "carbon");
    const manifestPath = join(carbonDir, "manifest.toml");
    if (!this.workspace.exists(manifestPath)) return { staged: [] };

    const logger = opts?.logger ?? new MemoryLogger();
    const manifest = readAppManifest(this.workspace.readFile(manifestPath));
    const binDir = join(carbonDir, "bin", hostOsName(), hostArchName());
    const ext = hostExt();

    for (const [name, entry] of manifest.plugins) {
      if (!entry.enabled || entry.source !== "vendor") continue;
      const artifactPath = join(binDir, `${name}.${ext}`);
      if (this.workspace.exists(artifactPath)) continue;

      logger.step(`fetching vendor plugin "${name}" (declared in manifest.toml, not yet on disk)…`);
      await this.addStandard.execute({ name, targetApp: projectDir, logger });
    }

    if (!this.workspace.exists(join(carbonDir, "build.zig"))) return { staged: [] };

    const zig = await this.resolveZig(logger);
    const args = ["build", "--prefix", "."];
    if (opts?.release) args.push("-Drelease=true");

    const { code } = await this.processes.run(zig, args, { cwd: carbonDir, stdio: "inherit" });
    if (code !== 0) {
      throw new Error(`carbon/build.zig failed to build — exit code ${code}. See the compiler output above.`);
    }

    // 3. Sign every LOCAL plugin's just-built RELEASE artifact with this
    //    machine's dev-signing key — see PluginSigner.ts's "Developer
    //    (first-party local plugin) signing key" section. Only for
    //    `release: true` (i.e. `carbon run`, which is what ships): `carbon
    //    dev` builds fast unsigned Debug plugins and loads them via
    //    CARBON_ALLOW_UNSIGNED_PLUGINS instead (see dev.command.ts), so
    //    signing them here would be wasted work on every keystroke-driven
    //    rebuild. Vendor plugins are Carbon-signed already, at fetch time
    //    (AddStandardPluginUseCase) — untouched here.
    if (opts?.release) {
      const localNames = [...manifest.plugins].filter(([, e]) => e.enabled && e.source === "local");
      if (localNames.length > 0 && !hasDevSigningKey()) {
        logger.warn(
          `no dev-signing key found — the local plugin(s) built above (${localNames.map(([n]) => n).join(", ")}) ` +
            `will fail to load under \`carbon run\`. Run \`carbon dev-key generate\` once, then add the printed ` +
            `public key to this project's carbon.toml under [dev-signing].`,
        );
      } else {
        for (const [name] of localNames) {
          const artifactPath = join(binDir, `${name}.${ext}`);
          if (!this.workspace.exists(artifactPath)) continue;
          await signLocalPluginArtifact(artifactPath, logger);
        }
      }
    }

    return { staged: this.workspace.listFiles(binDir) };
  }
}
