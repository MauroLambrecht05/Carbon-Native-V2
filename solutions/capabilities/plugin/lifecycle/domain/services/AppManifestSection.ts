// Reading and writing carbon/manifest.toml — the real source of truth for
// which plugins compose an app.
//
// Unlike CapabilityGrants.ts's read of carbon.toml (a file a human owns, so
// every edit is a careful line operation), this file is TOOL-OWNED: `carbon
// plugin new`/`add`/`enable`/`disable` are its only writers, nobody hand-edits
// it in normal use — the same posture as a package-lock.json, not a
// package.json. That means a full parse → mutate → stringify round trip
// through a real TOML library is fine here; there is no human formatting to
// preserve.
//
//   schema = 1
//
//   [plugins.carbon-pulse]
//   source = "local"
//   enabled = true
//
//   [plugins.fonts]
//   source = "vendor"
//   version = "0.1.4"
//   enabled = true
//
// `source` says which of carbon/plugins/local/<name>/ or
// carbon/plugins/vendor/<name>/ owns this plugin's source/artifact-origin.
// `enabled = false` is the one surviving disable toggle — skipped by both
// carbon/build.zig (nothing built/staged) and the Rust loader (nothing
// loaded), directory and entry both left untouched.

import { parse, stringify } from "smol-toml";

export type PluginSource = "local" | "vendor";

export interface AppManifestEntry {
  readonly source: PluginSource;
  readonly enabled: boolean;
  /** Vendor only. Informational — nothing resolves against it today. */
  readonly version?: string;
}

export interface AppManifest {
  readonly schema: number;
  readonly plugins: ReadonlyMap<string, AppManifestEntry>;
}

const CURRENT_SCHEMA = 1;

/** Empty manifest (schema, no plugins) when the file is missing or unparseable. */
export function readAppManifest(toml: string): AppManifest {
  if (!toml.trim()) return { schema: CURRENT_SCHEMA, plugins: new Map() };

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(toml) as Record<string, unknown>;
  } catch {
    return { schema: CURRENT_SCHEMA, plugins: new Map() };
  }

  const schema = typeof parsed.schema === "number" ? parsed.schema : CURRENT_SCHEMA;
  const plugins = new Map<string, AppManifestEntry>();
  const rawPlugins = parsed.plugins;
  if (rawPlugins && typeof rawPlugins === "object") {
    for (const [name, value] of Object.entries(rawPlugins as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const source = v.source === "local" || v.source === "vendor" ? v.source : null;
      if (!source) continue;
      plugins.set(name, {
        source,
        enabled: typeof v.enabled === "boolean" ? v.enabled : true,
        version: typeof v.version === "string" ? v.version : undefined,
      });
    }
  }

  return { schema, plugins };
}

function toToml(manifest: AppManifest): string {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of manifest.plugins) {
    plugins[name] = {
      source: entry.source,
      enabled: entry.enabled,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
    };
  }
  return stringify({ schema: manifest.schema, plugins });
}

/** Adds (or replaces) one plugin entry, preserving every other entry. */
export function upsertManifestEntry(
  toml: string,
  name: string,
  entry: AppManifestEntry,
): string {
  const manifest = readAppManifest(toml);
  const plugins = new Map(manifest.plugins);
  plugins.set(name, entry);
  return toToml({ schema: manifest.schema, plugins });
}

/** Flips `enabled` for one already-declared plugin. No-op if it isn't declared. */
export function setManifestEnabled(toml: string, name: string, enabled: boolean): string {
  const manifest = readAppManifest(toml);
  const existing = manifest.plugins.get(name);
  if (!existing) return toml;
  const plugins = new Map(manifest.plugins);
  plugins.set(name, { ...existing, enabled });
  return toToml({ schema: manifest.schema, plugins });
}
