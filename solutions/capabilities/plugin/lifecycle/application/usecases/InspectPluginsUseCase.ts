// Answering "what is installed" and "what is this one".
//
// Both are reads over the same two sources — carbon/manifest.toml (which
// plugins compose this app, and where their source is) and a plugin's own
// carbon-plugin.toml — so they share a use case rather than each
// re-deriving where to look. carbon.toml's [plugins] table (capability
// grants) is a THIRD source, folded in for `list` so `carbon plugin list`
// can show what's actually granted.

import { join } from "node:path";
import { NoHostAppError, PluginNotFoundError } from "../../domain/errors/PluginError.ts";
import { grantedCapabilities } from "../../domain/services/CapabilityGrants.ts";
import { type PluginSource } from "../../domain/services/AppManifestSection.ts";
import { readAppManifest } from "../../infrastructure/AppManifestCodec.ts";
import { hostArchName, hostExt, hostOsName } from "../../domain/value-objects/NativeTarget.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

export interface InstalledPlugin {
  readonly name: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  /** carbon/bin/<os>/<arch>/<name>.<ext> — where the runtime looks. */
  readonly absolutePath: string;
  /**
   * False when carbon/manifest.toml declares it but `carbon/build.zig` has
   * never staged it (or the binary was cleaned away) — a normal state
   * before the first `carbon dev`/`run`, and the reason `list` reports it
   * rather than throwing.
   */
  readonly present: boolean;
  /** Granted by carbon.toml — empty if the plugin needs (or has) none. */
  readonly capabilities: readonly string[];
}

export interface PluginDetails {
  readonly name: string;
  /** Declared in carbon/manifest.toml, or found as source in the cwd. */
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

    const manifestPath = join(host, "carbon", "manifest.toml");
    const manifest = this.workspace.exists(manifestPath)
      ? readAppManifest(this.workspace.readFile(manifestPath))
      : { schema: 1, plugins: new Map() };

    const tomlPath = join(host, "carbon.toml");
    const toml = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";
    const granted = grantedCapabilities(toml);

    const ext = hostExt();
    const binDir = join(host, "carbon", "bin", hostOsName(), hostArchName());

    const plugins = [...manifest.plugins].map(([name, entry]) => {
      const absolutePath = join(binDir, `${name}.${ext}`);
      return {
        name,
        source: entry.source,
        enabled: entry.enabled,
        absolutePath,
        present: this.workspace.exists(absolutePath),
        capabilities: granted(name),
      };
    });

    return { host, plugins };
  }

  /**
   * Details for one plugin.
   *
   * Declared-in-the-manifest wins over bare source: if carbon/manifest.toml
   * lists it, that's the copy actually built/staged/loaded.
   *
   * @throws PluginNotFoundError
   */
  describe(name: string, from: string): PluginDetails {
    const host = this.workspace.findHostApp(from);
    if (host) {
      const manifestPath = join(host, "carbon", "manifest.toml");
      const manifest = this.workspace.exists(manifestPath)
        ? readAppManifest(this.workspace.readFile(manifestPath))
        : { schema: 1, plugins: new Map() };
      const entry = manifest.plugins.get(name);

      if (entry) {
        const absolutePath = join(host, "carbon", "bin", hostOsName(), hostArchName(), `${name}.${hostExt()}`);
        const sourceManifest = join(host, "carbon", "plugins", entry.source, name, "carbon-plugin.toml");
        return {
          name,
          origin: "installed",
          path: absolutePath,
          manifest: this.workspace.exists(sourceManifest) ? this.workspace.readFile(sourceManifest) : null,
        };
      }
    }

    // Not declared in any host app's manifest — a plugin scaffolded but
    // never `carbon plugin new`-declared (shouldn't normally happen, since
    // CreatePluginUseCase declares as it scaffolds, but a manually-copied
    // directory is real), or a bare `<from>/<name>/` standalone SDK-style
    // checkout with no host app above it at all (e.g. describing one of
    // carbon-sdk's own plugins by cwd).
    const candidates = [
      host ? join(host, "carbon", "plugins", "local", name, "carbon-plugin.toml") : null,
      join(from, name, "carbon-plugin.toml"),
    ].filter((p): p is string => p !== null);

    for (const sourceManifest of candidates) {
      if (this.workspace.exists(sourceManifest)) {
        return {
          name,
          origin: "source",
          path: sourceManifest,
          manifest: this.workspace.readFile(sourceManifest),
        };
      }
    }

    throw new PluginNotFoundError(name);
  }
}
