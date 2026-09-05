// Resolving a standard (carbon-sdk) plugin's real directory by name.
//
// carbon-sdk/plugins/ is two levels deep — a category folder (carbon-desktop,
// carbon-security, ...) grouping the plugins for that area, each an
// independently buildable+installable plugin in its own subdirectory
// (carbon-sdk/plugins/carbon-desktop/clipboard/, .../dialog/, ...). `carbon
// plugin add <name>` still takes just the plugin's own name — "clipboard",
// not "carbon-desktop/clipboard" — so both AddStandardPluginUseCase and
// StaticLinkPluginsUseCase need to search across category folders rather
// than joining directly onto `standardPluginsRoot`.

import { join } from "node:path";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

/**
 * The directory for standard plugin `name`, or `null` if no category under
 * `standardPluginsRoot` has a subdirectory by that name.
 */
export function resolveStandardPluginDir(
  workspace: PluginWorkspace,
  standardPluginsRoot: string,
  name: string,
): string | null {
  for (const category of workspace.listDirectories(standardPluginsRoot)) {
    const candidate = join(standardPluginsRoot, category, name);
    if (workspace.exists(candidate)) return candidate;
  }
  return null;
}

/** Every standard plugin's own name, flattened across all category folders — what an "unknown plugin, did you mean" error lists. */
export function listStandardPluginNames(workspace: PluginWorkspace, standardPluginsRoot: string): string[] {
  const names: string[] = [];
  for (const category of workspace.listDirectories(standardPluginsRoot)) {
    names.push(...workspace.listDirectories(join(standardPluginsRoot, category)));
  }
  return names;
}
