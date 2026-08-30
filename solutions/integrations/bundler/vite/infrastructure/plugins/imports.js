// @carbon/vite/imports — resolves `import 'carbon:*'` virtual modules
// at build time and validates that the imports are backed by plugins the
// user actually granted in `carbon.toml [plugins]`.
//
// What this looks like end-to-end
// -------------------------------
// User code:
//
//     import { AudioContext, OscillatorNode } from 'carbon:audio';
//
// At build time we intercept the `carbon:audio` specifier in resolveId,
// emit a virtual module from `load`, and the bundler folds the contents
// inline:
//
//     export const AudioContext   = globalThis.AudioContext;
//     export const OscillatorNode = globalThis.OscillatorNode;
//
// At runtime the native carbon-audio plugin has already installed those
// classes onto globalThis (see carbon/host/audio/src/lib.rs::register_audio).
// The whole bridge is two property reads — no IPC, no proxies, no runtime cost.
//
// Capability check
// ----------------
// `carbon.toml [plugins]` is the user's authoritative grant list:
//
//     [plugins]
//     audio = true
//
// If user code imports `carbon:audio` but `audio = true` isn't declared,
// we emit a build error pointing at the offending file. That keeps the
// principle-of-least-privilege story — code can't reach for capabilities
// the user hasn't explicitly opted into.
//
// Pattern note
// ------------
// This plugin pairs `resolveId` + `load` for the virtual module pattern
// (mirrors @carbon/vite/ink-shim's companion-stub mechanism). The
// virtual ids are `\0` prefixed so other Vite plugins don't try to read
// them off disk — a Rollup convention every well-behaved plugin honors.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import {
  BUILTIN_MODULES,
  BUILTIN_SPECIFIERS,
  pluginNameOf,
} from "../../domain/module-graph.js";
import {
  buildSpecifierMap,
  discoverLocalManifests,
  discoverManifests,
} from "../../domain/import-manifest.js";

const VIRTUAL_PREFIX = "\0carbon-imports:";

/**
 * `carbon:*` specifiers with no real web-platform equivalent — process
 * spawning, raw hardware access. These are resolvable only from the app's
 * own source, never from a dependency, because there is no "looks like web"
 * ergonomics being preserved by exposing them broadly: no legitimate
 * frontend library expects ambient process-spawning to exist at all. See
 * .local/notes/roadmap/04-security-and-capabilities/README.md, Layer 1.
 *
 * This is defense-in-depth, not the primary boundary — the primary one is
 * that `carbon.toml [runtime] process = true` gates whether the underlying
 * `__cm_proc_*` globals are ever installed on `globalThis` at all (see
 * `solutions/infrastructure/os/lib.rs::register_all`). A dependency that
 * somehow reached the raw global directly wouldn't be stopped by this
 * check alone; this closes the *import* path specifically, so a dependency
 * can't even get the ergonomic named export.
 */
const FIRST_PARTY_ONLY_SPECIFIERS = new Set(["process"]);

/** True when `importer` is a path inside some `node_modules/` tree. */
function isDependencyImporter(importer) {
  if (typeof importer !== "string") return false;
  const normalized = importer.replace(/\\/g, "/");
  return normalized.includes("/node_modules/");
}

/**
 * @typedef {Object} CarbonImportsOptions
 * @property {boolean} [debug]            Log per-file rewrites + manifest discovery.
 * @property {string}  [carbonToml]       Override path to carbon.toml. Default: <root>/carbon.toml.
 * @property {string}  [workspaceRoot]    Override directory containing packages/* manifests.
 *                                        Default: walk upward from project root looking for `packages/`.
 * @property {boolean} [skipCapabilityCheck] Disable the capability validation pass. Off-switch for tests
 *                                        and for projects that intentionally don't ship a carbon.toml.
 * @property {Record<string, string[]>} [extraModules] Extra `carbon:*` → exports the plugin should
 *                                        recognize on top of the BUILTIN_MODULES table.
 */

/**
 * @param {CarbonImportsOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function carbonImports(options = {}) {
  const {
    debug = false,
    carbonToml: carbonTomlOverride,
    workspaceRoot: workspaceRootOverride,
    skipCapabilityCheck = false,
    extraModules = {},
  } = options;

  // Lazily-populated state — set in configResolved (which is also called
  // when the plugin is exercised through bun-build's plugin shape; we treat
  // missing context defensively so unit tests can drive the plugin directly).
  /** @type {Map<string, Array<{name: string, global: string}>>} */
  let specifierMap = new Map();
  /** Specifiers whose exports came from a plugin manifest rather than
   * BUILTIN_MODULES — see buildSpecifierMap's doc comment for why these need
   * different codegen (lazy function wrappers, not an eager `export const`
   * snapshot: the runtime installs a plugin's globals after the bundle
   * evaluates, so an eager snapshot would permanently capture `undefined`).
   * @type {Set<string>} */
  let manifestSpecifiers = new Set();
  /** @type {Set<string>} */
  let grantedPlugins = new Set();
  /** @type {string | null} */
  let projectRoot = null;
  /** @type {boolean} */
  let capabilityCheckActive = !skipCapabilityCheck;

  /** Build the merged specifier map from BUILTIN_MODULES + manifests + extraModules. */
  function buildMaps(root) {
    projectRoot = root ?? null;
    const wsRoot =
      workspaceRootOverride ?? (root ? findWorkspaceRoot(root) : null);
    // Local manifests (the app's own carbon/plugins/{local,vendor}/<name>/
    // carbon-plugin.toml, per run.command.ts's syncPlugins) take priority over a
    // packages/-workspace manifest of the same name — an app's own plugin
    // source is more specific than whatever a monorepo-wide package
    // declares, and is in practice the only kind that exists today.
    const manifests = wsRoot ? discoverManifests(wsRoot) : new Map();
    if (root) {
      for (const [name, m] of discoverLocalManifests(root)) {
        manifests.set(name, m);
      }
    }
    const { map, manifestSpecifiers: lazySpecs } = buildSpecifierMap(manifests, {
      ...BUILTIN_MODULES,
      // Allow callers to register extras; the array is in [name, name, ...]
      // shape — turn it into the {name, global} list the resolver wants.
      ...Object.fromEntries(
        Object.entries(extraModules).map(([spec, names]) => [
          spec,
          (names ?? []).map((name) => ({ name, global: name })),
        ]),
      ),
    });
    specifierMap = map;
    manifestSpecifiers = lazySpecs;

    if (capabilityCheckActive && root) {
      grantedPlugins = readGrantedPlugins(root, carbonTomlOverride);
    } else {
      grantedPlugins = new Set();
    }

    if (debug) {
      console.log(
        `[carbon-imports] manifests=${manifests.size} specifiers=${specifierMap.size} ` +
          `grantedPlugins=${[...grantedPlugins].join(",") || "(none)"}`,
      );
    }
  }

  return {
    name: "@carbon/vite/imports",
    enforce: "pre",

    configResolved(cfg) {
      buildMaps(cfg?.root ?? process.cwd());
    },

    // ── resolveId: intercept `carbon:*` specifiers ─────────────────────
    resolveId(source, importer) {
      if (!isCarbonSpecifier(source)) return null;

      // Lazy initialization: if configResolved didn't fire (e.g. when the
      // plugin is being driven from a non-Vite host or a unit test), pull
      // up a default before we resolve anything.
      if (specifierMap.size === 0) {
        buildMaps(process.cwd());
      }

      // Capability check: every `carbon:*` import must correspond to a
      // declared plugin. We do the check here (resolveId) rather than in
      // load() so that the error message points at the *importer*, the
      // file the user actually wrote, not the synthesized virtual module.
      const pluginName = pluginNameOf(source);
      if (capabilityCheckActive && pluginName) {
        if (grantedPlugins.size > 0 && !grantedPlugins.has(pluginName)) {
          const where = importer ? ` from ${importer}` : "";
          // Throwing inside resolveId is the canonical way to signal a
          // hard build error in Vite/Rollup — it propagates with the
          // file/position info attached.
          this.error(
            `[carbon] '${source}' imported${where} but '${pluginName}' is not ` +
              `declared in carbon.toml [plugins]. Add \`${pluginName} = true\` to ` +
              `[plugins] or remove the import.`,
          );
        }
      }

      // First-party-only specifiers: refuse the import outright if it comes
      // from inside node_modules, regardless of capability grants — a
      // dependency has no legitimate reason to ask for process spawning,
      // and a compromised one shouldn't get the ergonomic named-export path
      // even as a convenience.
      if (pluginName && FIRST_PARTY_ONLY_SPECIFIERS.has(pluginName) && isDependencyImporter(importer)) {
        this.error(
          `[carbon] '${source}' imported from ${importer} — this module is only ` +
            `importable from the app's own source, never from a dependency. ` +
            `See .local/notes/roadmap/04-security-and-capabilities/README.md.`,
        );
      }

      // Whether or not we recognize the specifier in our merged table, we
      // still produce a virtual id. Unknown specifiers fall through to the
      // load hook which emits a clear "no exports declared" stub so the
      // user gets a comprehensible error rather than a "Module not found".
      return VIRTUAL_PREFIX + source;
    },

    // ── load: serve the synthesized re-export module ──────────────────
    load(id) {
      if (typeof id !== "string" || !id.startsWith(VIRTUAL_PREFIX)) return null;
      const specifier = id.slice(VIRTUAL_PREFIX.length);

      const exports = specifierMap.get(specifier);
      if (!exports || exports.length === 0) {
        // The specifier had the carbon: prefix but neither manifests nor the
        // BUILTIN_MODULES table told us anything about it. Emit a stub that
        // throws on first reference so user code fails loudly at runtime
        // instead of silently getting `undefined`.
        const pluginName = pluginNameOf(specifier) ?? "<unknown>";
        return synthesizeUnknownStub(specifier, pluginName);
      }

      if (debug) {
        console.log(
          `[carbon-imports] load '${specifier}' → ${exports.length} export(s)`,
        );
      }
      return synthesizeReExports(specifier, exports, manifestSpecifiers.has(specifier));
    },
  };
}

/** Heuristic match for `carbon:*` specifiers (cheap path before doing any work). */
function isCarbonSpecifier(source) {
  return typeof source === "string" && source.startsWith("carbon:");
}

/**
 * Read `carbon.toml [plugins]` and return the set of plugin names with a
 * truthy grant. A plugin entry can be:
 *   audio = true          → granted
 *   audio = false         → NOT granted
 *   audio = { ... }       → granted (any object form is a config + grant)
 *   audio = "1.0.0"       → granted (version pin, future)
 *
 * Returns an empty set if the file or the section doesn't exist; in that case
 * the capability check becomes a no-op (we have no grants to check against).
 */
function readGrantedPlugins(projectRoot, override) {
  const path = override ?? join(projectRoot, "carbon.toml");
  if (!existsSync(path)) return new Set();
  let parsed;
  try {
    parsed = parseToml(readFileSync(path, "utf8"));
  } catch {
    // Don't let a broken carbon.toml fail the whole build; the runtime
    // will surface the parse error separately when it loads.
    return new Set();
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return new Set();
  const granted = new Set();
  for (const [name, val] of Object.entries(plugins)) {
    if (val === true) granted.add(name);
    else if (val && typeof val === "object") granted.add(name);
    else if (typeof val === "string" && val.length > 0) granted.add(name);
  }
  return granted;
}

/**
 * Walk parent directories from `projectRoot` looking for one that contains a
 * `packages/` directory — that's the workspace root for manifest discovery.
 * Falls back to projectRoot if nothing matches (useful for single-package
 * projects that vendor carbon-plugin.toml right next to their app).
 */
function findWorkspaceRoot(projectRoot) {
  let dir = projectRoot;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return projectRoot;
}

/**
 * Build the synthesized JS module body for a known specifier.
 *
 * @param {string} specifier
 * @param {Array<{name: string, global: string}>} list
 * @param {boolean} lazy When true, emit a function wrapper that reads
 *   `globalThis.<global>` on every CALL rather than an eager `export const`
 *   snapshot taken once at import time. Manifest (plugin) exports need this:
 *   the runtime installs a plugin's globals via `dispatch_register`, which
 *   runs AFTER the bundle evaluates (see mini.rs's composition root), so an
 *   eager snapshot at import time would permanently capture `undefined` —
 *   the exact bug this was written to fix (carbon-pulse's `setActive`
 *   throwing "not a function" the first time real user code called it).
 *   BUILTIN_MODULES exports (audio, image, …) don't need this: their
 *   globals come from native registration that runs BEFORE the bundle, and
 *   some of them are classes (`new AudioContext()`), which a function
 *   wrapper cannot stand in for.
 */
function synthesizeReExports(specifier, list, lazy = false) {
  const lines = [
    `// @carbon/vite/imports — virtual module for ${JSON.stringify(specifier)}`,
    `// Bridges build-time imports to runtime globals installed by the matching`,
    `// native plugin. No IPC, no proxies; each binding is a globalThis property read.`,
  ];
  for (const { name, global } of list) {
    // We only allow identifier-shaped names + globals. The data table is
    // ours, but keep the export emitter defensive against future inputs.
    if (!isIdentifier(name)) {
      lines.push(`// skipped invalid export name: ${JSON.stringify(name)}`);
      continue;
    }
    if (!isIdentifier(global)) {
      lines.push(`// skipped invalid global ref: ${JSON.stringify(global)}`);
      continue;
    }
    if (lazy) {
      lines.push(
        `export function ${name}(...args) { return globalThis.${global}(...args); }`,
      );
    } else {
      lines.push(`export const ${name} = globalThis.${global};`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Stub returned when a `carbon:*` specifier is unknown (no manifest, no
 * BUILTIN_MODULES entry). The user gets a clear runtime error mentioning
 * the specifier they tried to import.
 */
function synthesizeUnknownStub(specifier, pluginName) {
  const msg =
    `carbon: unknown virtual module ${JSON.stringify(specifier)}. ` +
    `Plugin '${pluginName}' is granted in carbon.toml but exposes no JS API ` +
    `(no carbon-plugin.toml manifest, not in the BUILTIN_MODULES table).`;
  return [
    `// @carbon/vite/imports — unrecognized virtual module ${JSON.stringify(specifier)}`,
    `const _msg = ${JSON.stringify(msg)};`,
    `if (typeof console !== "undefined") console.warn(_msg);`,
    `export default new Proxy({}, { get() { throw new Error(_msg); } });`,
  ].join("\n") + "\n";
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function isIdentifier(s) {
  return typeof s === "string" && IDENT_RE.test(s);
}

export { BUILTIN_MODULES, BUILTIN_SPECIFIERS, pluginNameOf };
export default carbonImports;
