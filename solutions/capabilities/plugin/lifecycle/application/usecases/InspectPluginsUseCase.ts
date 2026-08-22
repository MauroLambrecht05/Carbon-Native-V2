// Answering "what is installed" and "what is this one".
//
// Both are reads over the same two sources — the host app's [plugins] table and
// a plugin's own carbon-plugin.toml — so they share a use case rather than
// each re-deriving where to look.

import { dirname, join } from "node:path";
import { NoHostAppError, PluginNotFoundError } from "../../domain/errors/PluginError.ts";
import { readPluginEntries } from "../../domain/services/PluginsSection.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

export interface InstalledPlugin {
  readonly name: string;
  /** As written in carbon.toml. */
  readonly path: string;
  readonly absolutePath: string;
  /**
   * False when carbon.toml declares it but the file is gone — a normal state
   * after a clean, and the reason `list` reports it rather than throwing.
   */
  readonly present: boolean;
}

export interface PluginDetails {
  readonly name: string;
  /** Installed into a host app, or found as source in the cwd. */
  readonly origin: "installed" | "source";
  readonly path: string;
  /** Contents of its carbon-plugin.toml, when there is one. */
  readonly manifest: string | null;
}

export class InspectPluginsUseCase {
  constructor(private readonly workspace: PluginWorkspace) {}

  /** @throws NoHostAppError */
  list(from: string): { host: string; plugins: InstalledPlugin[] } {
    const host = this.workspace.findHostApp(from);
    if (!host) throw new NoHostAppError(from);

    const tomlPath = join(host, "carbon.toml");
    const toml = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";

    const plugins = readPluginEntries(toml).map((entry) => {
      const absolutePath = join(host, entry.path);
      return {
        name: entry.name,
        path: entry.path,
        absolutePath,
        present: this.workspace.exists(absolutePath),
      };
    });

    return { host, plugins };
  }

  /**
   * Details for one plugin.
   *
   * Installed wins over source: if a host app declares it, that is the copy
   * actually being loaded, and the source tree may have moved on.
   *
   * @throws PluginNotFoundError
   */
  describe(name: string, from: string): PluginDetails {
    const host = this.workspace.findHostApp(from);
    if (host) {
      const tomlPath = join(host, "carbon.toml");
      const toml = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";
      const entry = readPluginEntries(toml).find((e) => e.name === name);

      if (entry) {
        const absolutePath = join(host, entry.path);
        // The manifest sits beside the installed library, if it was copied too.
        const sibling = join(dirname(absolutePath), "carbon-plugin.toml");
        return {
          name,
          origin: "installed",
          path: absolutePath,
          manifest: this.workspace.exists(sibling) ? this.workspace.readFile(sibling) : null,
        };
      }
    }

    const sourceManifest = join(from, name, "carbon-plugin.toml");
    if (this.workspace.exists(sourceManifest)) {
      return {
        name,
        origin: "source",
        path: sourceManifest,
        manifest: this.workspace.readFile(sourceManifest),
      };
    }

    throw new PluginNotFoundError(name);
  }
}
