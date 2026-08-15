// The `extension-points` and `[capabilities]` a carbon-plugin.toml declares.
//
// Read with the same shallow line reader as the rest of this capability, and
// for the same reason: this file is read to answer questions long before
// anything is willing to depend on a TOML parser being present, and it belongs
// to a human whose comments and formatting are not ours to normalise.
//
// Shallow means it understands exactly two shapes:
//
//   extension-points = ["a.b", "c.d"]        a top-level array of strings
//   required = ["x"]  inside [capabilities]  the same, in one section
//
// and ignores everything else. A manifest carrying fields this version does
// not model still reads.

/** A plugin's declared surface, as its manifest states it. */
export interface PluginDeclaration {
  /** Extension point ids, verbatim — validated against the registry later. */
  readonly extensionPoints: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly optionalCapabilities: readonly string[];
}

/** Values of a `key = ["a", "b"]` line, or null when the key is absent. */
function readStringArray(toml: string, key: string, section: string | null): string[] | null {
  let current: string | null = null;

  for (const raw of toml.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (line.startsWith("[") && line.endsWith("]") && !line.includes("=")) {
      // `[capabilities]` — a section header, not an array value. An array
      // assignment always has an `=` before its bracket, which is what
      // separates the two here.
      current = line.slice(1, -1);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    if (current !== section) continue;

    const value = line.slice(eq + 1).trim();
    if (!value.startsWith("[")) continue;

    // Single-line arrays only. A multi-line array is legal TOML and this
    // returns null for it rather than reading half of one — the caller then
    // reports "not declared", which is wrong but visible, where a half-read
    // list would silently validate a subset.
    const inner = value.slice(1, value.lastIndexOf("]"));
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter((item) => item.length > 0);
  }

  return null;
}

export function parsePluginDeclaration(toml: string): PluginDeclaration {
  return {
    // `extension-points` is the current spelling. `hooks` was the ABI 1.0 one
    // and manifests using it are in the wild, so both are read and merged.
    extensionPoints: [
      ...(readStringArray(toml, "extension-points", null) ?? []),
      ...(readStringArray(toml, "hooks", null) ?? []),
    ],
    requiredCapabilities: readStringArray(toml, "required", "capabilities") ?? [],
    optionalCapabilities: readStringArray(toml, "optional", "capabilities") ?? [],
  };
}
