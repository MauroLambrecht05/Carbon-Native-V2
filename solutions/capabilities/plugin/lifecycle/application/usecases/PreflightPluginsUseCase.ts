// Will this app's plugins actually load?
//
// Run by `carbon run` before the runtime starts. Everything it reports, the
// runtime would also report — as `[carbon-plugin] FAILED to load ...` on
// stderr, after the window is already up, in a stream the user is not reading
// because they are looking at an app that is missing a feature.
//
// The toolchain can say the same thing a second earlier, next to the file to
// edit, which is the whole value.

import { dirname, join } from "node:path";

import { extensionPoint } from "@carbon/contracts/plugin/extension-points";

import { parsePluginDeclaration } from "../../domain/entities/PluginDeclaration.ts";
import { NoHostAppError } from "../../domain/errors/PluginError.ts";
import { readPluginEntries } from "../../domain/services/PluginsSection.ts";
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

    const tomlPath = join(host, "carbon.toml");
    const toml = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";
    const entries = readPluginEntries(toml);
    const granted = grantedCapabilities(toml);

    const problems: PluginProblem[] = [];

    for (const entry of entries) {
      const absolutePath = join(host, entry.path);

      // The commonest one by a wide margin: a plugin declared in carbon.toml
      // whose library was never built, or was cleaned away.
      if (!this.workspace.exists(absolutePath)) {
        problems.push({
          plugin: entry.name,
          severity: "error",
          message: `declared in carbon.toml but ${entry.path} does not exist`,
          fix: "build and install it: carbon plugin build --release && carbon plugin install",
        });
        continue;
      }

      // The plugin's own manifest, if it was installed beside the library.
      // Absent is not a problem — only the built library ships — so anything
      // below this point is best-effort.
      const manifestPath = join(dirname(absolutePath), "carbon-plugin.toml");
      if (!this.workspace.exists(manifestPath)) continue;

      const declaration = parsePluginDeclaration(this.workspace.readFile(manifestPath));
      const wanted = new Set<string>(declaration.requiredCapabilities);

      // Every capability its declared points imply, whether or not the
      // manifest listed them: the loader gates per point, not per manifest.
      for (const id of declaration.extensionPoints) {
        const capability = extensionPoint(id)?.capability;
        if (capability) wanted.add(capability);
      }

      const missing = [...wanted].filter((capability) => !granted(entry.name).includes(capability));
      if (missing.length > 0) {
        problems.push({
          plugin: entry.name,
          severity: "error",
          message: `needs ${missing.map((m) => `"${m}"`).join(", ")}, which carbon.toml does not grant`,
          fix:
            `add to carbon.toml:\n    [plugins.${entry.name}]\n    capabilities = [` +
            missing.map((m) => `"${m}"`).join(", ") +
            "]",
        });
      }

      for (const id of declaration.extensionPoints) {
        if (!extensionPoint(id)) {
          problems.push({
            plugin: entry.name,
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

/**
 * `[plugins.<name>] capabilities = [...]`, read shallowly.
 *
 * Returns a lookup rather than a map so the caller reads naturally, and so an
 * undeclared plugin answers with an empty list rather than undefined.
 */
function grantedCapabilities(toml: string): (plugin: string) => string[] {
  const byPlugin = new Map<string, string[]>();
  let current: string | null = null;

  for (const raw of toml.split("\n")) {
    const line = raw.split("#")[0].trim();

    if (line.startsWith("[") && line.endsWith("]") && !line.includes("=")) {
      const header = line.slice(1, -1);
      current = header.startsWith("plugins.") ? header.slice("plugins.".length) : null;
      continue;
    }
    if (current === null) continue;

    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== "capabilities") continue;

    const value = line.slice(eq + 1).trim();
    if (!value.startsWith("[")) continue;

    byPlugin.set(
      current,
      value
        .slice(1, value.lastIndexOf("]"))
        .split(",")
        .map((item) => item.trim().replace(/^"|"$/g, ""))
        .filter((item) => item.length > 0),
    );
  }

  return (plugin: string) => byPlugin.get(plugin) ?? [];
}
