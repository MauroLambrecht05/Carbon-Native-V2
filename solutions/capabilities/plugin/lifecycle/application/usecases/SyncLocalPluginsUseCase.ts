// Auto-build + install every plugin whose SOURCE lives inside the app's own
// carbon/own/ directory, so `carbon run`/`carbon dev` need no separate
// `carbon plugin install` step — the plugin is part of the app project, and
// building the app builds it.
//
// ── carbon/ — an app's native development area ─────────────────────────────
// Not a flat dumping ground for compiled plugin output — a real place to
// develop plugins in, split the way a dependency is distinct from your own
// code in any package manager:
//
//   carbon/own/<name>/       a plugin whose SOURCE this app owns: build.zig,
//                            src/, carbon-plugin.toml — a full, editable
//                            plugin project, scaffolded here by `carbon
//                            plugin new` when run inside an app. This use
//                            case builds and installs every one of these on
//                            every `carbon dev`/`carbon run`.
//   carbon/installed/<name>/ a fetched-or-built ARTIFACT: <name>.dll,
//                            <name>.dll.sig, carbon-plugin.toml — what
//                            `carbon plugin add` (standard plugins) writes,
//                            and where THIS use case installs the result of
//                            building a carbon/own/ plugin too. Never
//                            hand-edited; always safe to delete and
//                            regenerate from carbon/own/ + `carbon.toml
//                            [plugins]`.
//
// Convention, not configuration: any `<projectDir>/carbon/own/<name>/`
// holding a language marker file (build.zig for Zig) is a plugin the app
// owns the source of. A plain `<projectDir>/carbon/installed/<name>/` some
// other tool populated is untouched here — it has no source to build, only
// carbon/own/ does.

import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import { LANGUAGES } from "../../domain/value-objects/PluginLanguage.ts";
import { readPluginEntries } from "../../domain/services/PluginsSection.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";
import type { BuildPluginUseCase } from "./BuildPluginUseCase.ts";
import { forwardSlashes } from "./CreatePluginUseCase.ts";
import type { InstallPluginUseCase } from "./InstallPluginUseCase.ts";

export interface SyncedLocalPlugin {
  readonly name: string;
  readonly directory: string;
}

export interface SyncLocalPluginsResult {
  readonly synced: readonly SyncedLocalPlugin[];
}

export class SyncLocalPluginsUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly build: BuildPluginUseCase,
    private readonly install: InstallPluginUseCase,
  ) {}

  /**
   * `release` defaults to false: a Debug zig build skips LLVM's optimization
   * passes entirely, which is most of a native build's compile time. `carbon
   * dev` wants that on every hot-reload rebuild the same way it already
   * wants plain .js over bytecode — the plugin binary's own runtime speed
   * does not matter while iterating, wall-clock rebuild time does. `carbon
   * run`/`carbon build` pass `release: true` explicitly for the artifact
   * that ships.
   */
  async execute(
    projectDir: string,
    options?: { readonly release?: boolean; readonly logger?: Logger },
  ): Promise<SyncLocalPluginsResult> {
    const release = options?.release ?? false;
    const ownDir = join(projectDir, "carbon", "own");
    const synced: SyncedLocalPlugin[] = [];

    for (const entry of this.workspace.listDirectories(ownDir)) {
      const directory = join(ownDir, entry);
      const isSource = LANGUAGES.some((l) => this.workspace.exists(join(directory, l.marker)));
      if (!isSource) continue;

      const result = await this.build.execute({ directory, release, logger: options?.logger });
      if (result.exitCode !== 0) {
        throw new Error(
          `local plugin "${entry}" (${join("carbon", "own", entry)}) failed to build — ` +
            `exit code ${result.exitCode}. See the compiler output above.`,
        );
      }

      this.install.execute({
        directory,
        from: projectDir,
        declare: !this.alreadyDeclared(projectDir, entry),
      });
      synced.push({ name: entry, directory: forwardSlashes(directory) });
    }

    return { synced };
  }

  /**
   * True once an author has written ANY carbon.toml declaration for this
   * plugin — bare (`name = "..."`, what install itself writes the first
   * time) or the `[plugins.<name>]` table form (what granting a capability
   * requires). Re-running install must not touch either: it would clobber a
   * capability grant back to a bare path, or — worse, since TOML forbids
   * redeclaring one key two ways — produce a duplicate-key parse error by
   * adding a bare line inside `[plugins]` next to an existing
   * `[plugins.<name>]` table.
   */
  private alreadyDeclared(projectDir: string, name: string): boolean {
    const tomlPath = join(projectDir, "carbon.toml");
    if (!this.workspace.exists(tomlPath)) return false;
    const toml = this.workspace.readFile(tomlPath);

    if (readPluginEntries(toml).some((e) => e.name === name)) return true;
    return new RegExp(`^\\s*\\[plugins\\.${escapeRegExp(name)}\\]`, "m").test(toml);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
