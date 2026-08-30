// Auto-build + install every plugin whose SOURCE lives inside the app's own
// plugins/ directory, so `carbon run`/`carbon dev` need no separate
// `carbon plugin install` step — the plugin is part of the app project, and
// building the app builds it.
//
// Convention, not configuration: any `<projectDir>/plugins/<name>/` holding
// a language marker file (build.zig for Zig) is a plugin the app owns the
// source of, distinct from a plugin some OTHER registered path merely points
// at. A plain `<projectDir>/plugins/<name>.dll` some other tool dropped in is
// untouched — it has no directory of that name to match.

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
    const pluginsDir = join(projectDir, "plugins");
    const synced: SyncedLocalPlugin[] = [];

    for (const entry of this.workspace.listDirectories(pluginsDir)) {
      const directory = join(pluginsDir, entry);
      const isSource = LANGUAGES.some((l) => this.workspace.exists(join(directory, l.marker)));
      if (!isSource) continue;

      const result = await this.build.execute({ directory, release, logger: options?.logger });
      if (result.exitCode !== 0) {
        throw new Error(
          `local plugin "${entry}" (${join("plugins", entry)}) failed to build — ` +
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
