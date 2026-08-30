// Manifest discovery for `carbon-plugin.toml`.
//
// Each native plugin may ship a manifest describing the JS API surface it
// installs. When present, the manifest is the source of truth for which
// `carbon:*` modules exist and what they export — overriding the hardcoded
// BUILTIN_MODULES table.
//
// Real manifest format — this is `carbon-plugin.toml` as `carbon plugin
// check`/`carbon plugin install` actually read it (see e.g.
// labs/examples/pulse/plugins/carbon-pulse/carbon-plugin.toml), top-level,
// no `[plugin]` wrapper section:
//
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
// Two discovery roots, because two different things ship plugins:
//   discoverLocalManifests(projectRoot)   an app's OWN plugins, source at
//                                         `<projectRoot>/plugins/<name>/`
//                                         (see run.command.ts's
//                                         syncLocalPlugins) — the only kind
//                                         a real app has today.
//   discoverManifests(workspaceRoot)      a `packages/<plugin>/` monorepo
//                                         layout for plugins published
//                                         independently of any one app.
//                                         Kept for that shape; nothing in
//                                         this tree uses it yet.
//
// The discovery is lazy + cheap: each walks its directory once per Vite
// configResolved hook.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Shared directory-of-plugin-dirs walk for both discovery roots below. */
function scanPluginDirs(dir) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const pluginDir = join(dir, entry);
    let s;
    try {
      s = statSync(pluginDir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const tomlPath = join(pluginDir, "carbon-plugin.toml");
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
 * Walk `<projectRoot>/plugins/*` — one subdirectory per plugin, each holding
 * its own `carbon-plugin.toml` — and return manifests keyed by plugin name.
 * This is the discovery root every real app actually exercises:
 * `carbon.toml [plugins]` grants a name, and `plugins/<that name>/carbon-
 * plugin.toml` is where its JS exports live, whether that directory holds
 * a vendored plugin's own Zig source or just the prebuilt artifact `carbon
 * plugin install`/`add` copied in (InstallPluginUseCase writes both shapes
 * into the same per-plugin directory now — see its own comment on why).
 *
 * @param {string} projectRoot Absolute path to the app (carbon.toml's directory).
 * @returns {Map<string, ParsedManifest>}
 */
export function discoverLocalManifests(projectRoot) {
  if (!projectRoot) return new Map();
  return scanPluginDirs(join(projectRoot, "plugins"));
}

/**
 * Walk `<workspaceRoot>/packages/*` and return manifests keyed by plugin name.
 *
 * @param {string} workspaceRoot Absolute path containing the `packages/` dir.
 * @returns {Map<string, ParsedManifest>}
 */
export function discoverManifests(workspaceRoot) {
  if (!workspaceRoot) return new Map();
  return scanPluginDirs(join(workspaceRoot, "packages"));
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

/**
 * Convert raw TOML into a ParsedManifest, returning null if the shape is
 * wrong. `name`/`modules` are top-level keys — see the format note above;
 * there is no `[plugin]` wrapper section in a real carbon-plugin.toml.
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.name !== "string") return null;

  const modules = Array.isArray(raw.modules) ? raw.modules.slice() : [];

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
  return { name: raw.name, modules, exports: exportsMap };
}

/**
 * Collapse the discovered manifests into a single specifier → exports map,
 * suitable for handing to the resolver. Falls back to the BUILTIN_MODULES
 * table for any specifier no manifest covers.
 *
 * Also returns which specifiers came from a MANIFEST rather than
 * BUILTIN_MODULES — the caller needs to tell the two apart at codegen time.
 * A manifest-declared global is installed by a plugin's `carbon_plugin_
 * register`, which the runtime deliberately runs AFTER the bundle evaluates
 * (see products/carbon's mini.rs composition root — "dispatch_register runs
 * after the bundle eval... so plugins can install globals on top of an
 * already-live runtime"), so the global does not exist yet at the moment a
 * top-level `import` snapshots it. A BUILTIN_MODULES global (audio, image,
 * …) is installed by native registration that runs BEFORE the bundle, so it
 * has no such problem and can stay a plain, eager `export const`.
 *
 * @param {Map<string, ParsedManifest>} manifests
 * @param {Record<string, Array<{name: string, global: string}>>} builtin
 * @returns {{
 *   map: Map<string, Array<{name: string, global: string}>>,
 *   manifestSpecifiers: Set<string>,
 * }}
 */
export function buildSpecifierMap(manifests, builtin) {
  const out = new Map();
  const manifestSpecifiers = new Set();

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
      manifestSpecifiers.add(spec);
    }
  }

  return { map: out, manifestSpecifiers };
}
