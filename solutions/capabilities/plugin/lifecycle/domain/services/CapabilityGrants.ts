// Reading the [plugins] table of a carbon.toml — capability GRANTS only.
//
// This table is not a plugin registry. Which plugins exist, whether they're
// local or vendor, and whether they're enabled all live in carbon/manifest.toml
// (see AppManifestSection.ts) — a tool-owned, tool-written file. carbon.toml's
// [plugins] table is the one place left that a human hand-writes: granting a
// capability to a plugin already declared in the manifest, by name.
//
//   [plugins.carbon-pulse]
//   capabilities = ["paint.pixmap"]
//
// A plugin needing no capability needs no entry here at all — absence means
// zero grants, not "disabled" (disabling is manifest.toml's `enabled` field).
//
// Read-only, deliberately: nothing in this codebase writes a capability grant
// automatically. Handing out a capability is a security decision only a human
// makes, so there is no upsert function here — unlike the old PluginsSection
// this replaces, which auto-wrote a `path` line on every install.
//
// The parsing is shallow, on purpose (same reasoning as everywhere else this
// codebase hand-parses a human-owned TOML file): a full TOML round-trip would
// be pointless here since nothing writes back, but staying shallow keeps this
// file's assumptions honest about the one shape it actually reads.

/** Every capability grant declared under `[plugins.<name>]`. */
export function readCapabilityGrants(toml: string): Map<string, string[]> {
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

  return byPlugin;
}

/**
 * `[plugins.<name>] capabilities = [...]`, as a lookup rather than a map so
 * the caller reads naturally, and so an undeclared plugin answers with an
 * empty list rather than undefined.
 */
export function grantedCapabilities(toml: string): (plugin: string) => string[] {
  const byPlugin = readCapabilityGrants(toml);
  return (plugin: string) => byPlugin.get(plugin) ?? [];
}
