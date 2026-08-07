// Manifest discovery for `carbon-plugin.toml`.
//
// Each native plugin in `packages/<plugin>/` may ship a manifest describing
// the JS API surface it installs. When present, the manifest is the source
// of truth for which `carbon:*` modules exist and what they export — overriding
// the hardcoded BUILTIN_MODULES table.
//
// Manifest format (subject to refinement once the SDK agent locks it in):
//
//   [plugin]
//   name = "carbon-audio"
//   modules = ["carbon:audio"]
//
//   [exports."carbon:audio"]
//   names = ["AudioContext", "GainNode", "OscillatorNode", ...]
//   # optional explicit globals map; falls back to the same name on globalThis.
//   globals = { AudioContext = "AudioContext", GainNode = "GainNode" }
//
// We tolerate two shapes for the names list to keep the contract loose:
//   1. `[exports."carbon:audio"] names = [...]`
//   2. `[exports] "carbon:audio" = [...]`
//
// The discovery is lazy + cheap: we only walk `packages/` once per Vite
// configResolved hook.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Walk `<workspaceRoot>/packages/*` and return manifests keyed by plugin name.
 *
 * @param {string} workspaceRoot Absolute path containing the `packages/` dir.
 * @returns {Map<string, ParsedManifest>}
 */
export function discoverManifests(workspaceRoot) {
  const out = new Map();
  if (!workspaceRoot) return out;
  const packagesDir = join(workspaceRoot, "packages");
  if (!existsSync(packagesDir)) return out;

  let entries;
  try {
    entries = readdirSync(packagesDir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const dir = join(packagesDir, entry);
    let s;
    try {
      s = statSync(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const tomlPath = join(dir, "carbon-plugin.toml");
    if (!existsSync(tomlPath)) continue;

    let parsed;
    try {
      parsed = parseToml(readFileSync(tomlPath, "utf8"));
    } catch {
      // A malformed manifest shouldn't break the whole build — fall back
      // to the BUILTIN_MODULES table for that plugin.
      continue;
    }

    const m = normalizeManifest(parsed);
    if (m === null) continue;
    out.set(m.name, m);
  }

  return out;
}

/**
 * @typedef {Object} ParsedManifest
 * @property {string} name                        plugin name (matches [plugins] key)
 * @property {string[]} modules                   declared `carbon:*` specifiers
 * @property {Map<string, ManifestExports>} exports keyed by `carbon:*` specifier
 */
/**
 * @typedef {Object} ManifestExports
 * @property {string[]} names                     export names (PublicName form)
 * @property {Record<string, string>} globals     name → globalThis access expr
 */

/** Convert raw TOML into a ParsedManifest, returning null if the shape is wrong. */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const plugin = raw.plugin;
  if (!plugin || typeof plugin.name !== "string") return null;

  const modules = Array.isArray(plugin.modules) ? plugin.modules.slice() : [];

  const exportsMap = new Map();
  const exportsRaw = raw.exports ?? {};

  // Form 1: [exports."carbon:audio"] names = [...]
  for (const [key, value] of Object.entries(exportsRaw)) {
    if (Array.isArray(value)) {
      // Form 2: [exports] "carbon:audio" = [...]
      exportsMap.set(key, { names: value.slice(), globals: {} });
      continue;
    }
    if (value && typeof value === "object") {
      const names = Array.isArray(value.names) ? value.names.slice() : [];
      const globals =
        value.globals && typeof value.globals === "object"
          ? Object.fromEntries(
              Object.entries(value.globals).filter(
                ([, v]) => typeof v === "string",
              ),
            )
          : {};
      exportsMap.set(key, { names, globals });
    }
  }

  // Plugin may declare `modules` without expanding `[exports]`. Treat that as
  // "we know the module exists but we don't know its exports" and let the
  // BUILTIN_MODULES table fill in the gap.
  return { name: plugin.name, modules, exports: exportsMap };
}

/**
 * Collapse the discovered manifests into a single specifier → exports map,
 * suitable for handing to the resolver. Falls back to the BUILTIN_MODULES
 * table for any specifier no manifest covers.
 *
 * @param {Map<string, ParsedManifest>} manifests
 * @param {Record<string, Array<{name: string, global: string}>>} builtin
 * @returns {Map<string, Array<{name: string, global: string}>>}
 */
export function buildSpecifierMap(manifests, builtin) {
  const out = new Map();

  // Seed with hardcoded fallbacks so anything not covered by a manifest
  // still resolves.
  for (const [spec, list] of Object.entries(builtin)) {
    out.set(spec, list);
  }

  // Manifests override builtin entries on a per-specifier basis.
  for (const m of manifests.values()) {
    for (const spec of m.modules) {
      const exp = m.exports.get(spec);
      if (!exp) continue;
      const list = exp.names.map((name) => ({
        name,
        // Prefer an explicit global override, otherwise re-export the same
        // identifier name straight off globalThis.
        global: exp.globals[name] ?? name,
      }));
      out.set(spec, list);
    }
  }

  return out;
}
