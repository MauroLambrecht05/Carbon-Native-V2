// Reading and writing carbon/manifest.toml — the real source of truth for
// which plugins compose an app. See domain/services/AppManifestSection.ts
// for the shape this reads/writes.
//
// Infrastructure, not domain: this depends on smol-toml for a full parse ->
// mutate -> stringify round trip, which the domain layer may not do. Safe
// here specifically because manifest.toml is TOOL-OWNED — `carbon plugin
// new`/`add`/`enable`/`disable` are its only writers, nobody hand-edits it
// in normal use (the same posture as a package-lock.json, not a
// package.json) — so there is no human formatting to preserve, unlike
// CapabilityGrants.ts's read of carbon.toml (a file a human owns, hence that
// file's shallow line-based reader instead of a real parser).

import { parse, stringify } from "smol-toml";
import {
  type AppManifest,
  type AppManifestEntry,
  CURRENT_MANIFEST_SCHEMA,
} from "../domain/services/AppManifestSection.ts";

/** Empty manifest (schema, no plugins) when the file is missing or unparseable. */
export function readAppManifest(toml: string): AppManifest {
  if (!toml.trim()) return { schema: CURRENT_MANIFEST_SCHEMA, plugins: new Map() };

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(toml) as Record<string, unknown>;
  } catch {
    return { schema: CURRENT_MANIFEST_SCHEMA, plugins: new Map() };
  }

  const schema = typeof parsed.schema === "number" ? parsed.schema : CURRENT_MANIFEST_SCHEMA;
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
