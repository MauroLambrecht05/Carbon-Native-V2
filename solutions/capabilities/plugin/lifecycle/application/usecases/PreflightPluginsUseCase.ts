// Will this app's plugins actually load?
//
// Run by `carbon run` before the runtime starts. Everything it reports, the
// runtime would also report — as `[carbon-plugin] FAILED to load ...` on
// stderr, after the window is already up, in a stream the user is not reading
// because they are looking at an app that is missing a feature.
//
// The toolchain can say the same thing a second earlier, next to the file to
// edit, which is the whole value.

import { join } from "node:path";

import { extensionPoint } from "@carbon/contracts/plugin/extension-points";

import { parsePluginDeclaration } from "../../domain/entities/PluginDeclaration.ts";
import { NoHostAppError } from "../../domain/errors/PluginError.ts";
import { readAppManifest } from "../../domain/services/AppManifestSection.ts";
import { grantedCapabilities } from "../../domain/services/CapabilityGrants.ts";
import { hostArchName, hostExt, hostOsName } from "../../domain/value-objects/NativeTarget.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

export interface PluginProblem {
  readonly plugin: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly fix?: string;
}

export interface PreflightResult {
  readonly host: string;
  readonly checked: number;
  readonly problems: readonly PluginProblem[];
  /** False when at least one plugin definitely will not load. */
  readonly ok: boolean;
}

export class PreflightPluginsUseCase {
  constructor(private readonly workspace: PluginWorkspace) {}

  /**
   * @param projectDir the app being run.
   * @throws NoHostAppError when there is no carbon.toml at or above it.
   */
  execute(projectDir: string): PreflightResult {
    const host = this.workspace.findHostApp(projectDir);
    if (!host) throw new NoHostAppError(projectDir);

    const manifestPath = join(host, "carbon", "manifest.toml");
    const manifest = this.workspace.exists(manifestPath)
      ? readAppManifest(this.workspace.readFile(manifestPath))
      : { schema: 1, plugins: new Map() };

    const tomlPath = join(host, "carbon.toml");
    const toml = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";
    const granted = grantedCapabilities(toml);

    const ext = hostExt();
    const nativeDir = join(host, "carbon", "native", hostOsName(), hostArchName());

    const problems: PluginProblem[] = [];
    const entries = [...manifest.plugins];

    for (const [name, entry] of entries) {
      if (!entry.enabled) continue;
      const absolutePath = join(nativeDir, `${name}.${ext}`);

      // The commonest one by a wide margin: a plugin manifest.toml declares
      // that `carbon/build.zig` has never staged (or was cleaned away).
      if (!this.workspace.exists(absolutePath)) {
        problems.push({
          plugin: name,
          severity: "error",
          message: `declared in carbon/manifest.toml but ${absolutePath} does not exist`,
          fix: entry.source === "local" ? "run: carbon dev (or carbon run)" : "run: carbon dev (auto-fetches vendor plugins) or carbon plugin add " + name,
        });
        continue;
      }

      // The plugin's own manifest, read from its SOURCE location (own or
      // vendor) — native/ only ever holds the binary + signature, never a
      // copy of carbon-plugin.toml. Absent is not a problem — only the
      // built library ships — so anything below this point is best-effort.
      const sourceManifestPath = join(host, "carbon", "plugins", entry.source, name, "carbon-plugin.toml");
      if (!this.workspace.exists(sourceManifestPath)) continue;

      const declaration = parsePluginDeclaration(this.workspace.readFile(sourceManifestPath));
      const wanted = new Set<string>(declaration.requiredCapabilities);

      // Every capability its declared points imply, whether or not the
      // manifest listed them: the loader gates per point, not per manifest.
      for (const id of declaration.extensionPoints) {
        const capability = extensionPoint(id)?.capability;
        if (capability) wanted.add(capability);
      }

      const missing = [...wanted].filter((capability) => !granted(name).includes(capability));
      if (missing.length > 0) {
        problems.push({
          plugin: name,
          severity: "error",
          message: `needs ${missing.map((m) => `"${m}"`).join(", ")}, which carbon.toml does not grant`,
          fix:
            `add to carbon.toml:\n    [plugins.${name}]\n    capabilities = [` +
            missing.map((m) => `"${m}"`).join(", ") +
            "]",
        });
      }

      for (const id of declaration.extensionPoints) {
        if (!extensionPoint(id)) {
          problems.push({
            plugin: name,
            severity: "warning",
            message: `declares "${id}", which this runtime's registry does not have`,
            fix: "built against a newer SDK — that point will not be called",
          });
        }
      }
    }

    return {
      host,
      checked: entries.length,
      problems,
      ok: !problems.some((p) => p.severity === "error"),
    };
  }
}
