/// <reference path="./vendor.d.ts" />
// The reference is load-bearing, not decorative. vendor.d.ts declares the four
// untyped Babel packages imported below; an ambient .d.ts only applies to
// programs that include it, and products/ compiles this file through a path
// alias without globbing solutions/. Referencing it from the one file that
// needs it means every consumer gets the declarations, wherever they compile
// from.

// build-pipeline.ts — replaces Vite for the carbon-mini build path.
//
// Pipeline:
//   1. Bun.build with a custom plugin that intercepts every project source
//      file (.tsx, .ts, .jsx, .js outside node_modules).
//   2. For each intercepted file, run @babel/core.transformSync with our
//      preset chain:
//        - carbon-three-bridge      (lifts <Canvas> JSX subtrees into a
//                                    builder fn so they evaluate against
//                                    @carbon/three-fiber's renderer instead
//                                    of the outer carbon-mini moduleName.
//                                    Auto-skipped when the project has
//                                    neither @carbon/three-fiber nor
//                                    @carbon/three in deps.)
//        - carbon-transforms-babel  (strip console.* + DEBUG blocks)
//        - carbon-tailwind-babel    (compile static class="..." → style={{}})
//        - babel-preset-solid       (JSX → universal-mode runtime calls)
//      The output is fed back to Bun with `loader: tsx/ts/jsx` so Bun's own
//      TS/JSX stripper handles whatever syntax (declare, type-only imports)
//      Babel left in place. This is faster than chaining
//      @babel/preset-typescript on top.
//   3. Bun bundles the (transformed) module graph into a single ESM file at
//      dist/bundle.js.
//
// In addition to the babel chain, the Bun.build path runs a small set of
// Vite-shaped plugins via the adapter below:
//   - carbon-fast-import: rewrites `import { Vector3 } from 'three'` to
//     pull from `carbon-fast-math` instead, so apps can opt into Rust-
//     backed math classes without touching source. This used to only run
//     through the Vite path; we now also run it in the Bun.build path
//     (registered BEFORE Babel so the import rewrite is visible to the
//     bundler). Skipped when neither three nor carbon-fast-math is in deps.
//   - carbonImports / carbonAssets / carbonDev: virtual carbon:* modules
//     and dev-injection (existing behavior).
//
// Why a Bun.build plugin instead of "transform to temp dir, then bun build":
//   - Single process: no extra fs writes between Babel and Bun
//   - The plugin's onLoad hook is the canonical extension point for this
//     kind of source-level codegen, and the timing wins (~50 ms) come from
//     not doing the temp-tree round-trip.
//
// Per-file Babel cache:
//   For HMR rebundles a single .tsx edit normally re-runs Babel against
//   every file in the graph (~10–30 files in mini-counter; ~700 ms total).
//   We side-step that by content-addressing the Babel output:
//     <projectDir>/.carbon-cache/babel/<sha256>.js   <- transform result
//     <projectDir>/.carbon-cache/babel/<sha256>.meta <- {sourceMap?}, optional
//   The hash key folds in (a) the source content, (b) a stable signature of
//   the babel config used for that pass, (c) the babel core / preset
//   versions, and (d) the pipeline phase ("phase1" / "phase2"). When any
//   of those change the entry naturally orphans (and gets pruned the next
//   time we exceed MAX_FILES).
//
// Caveats: see VITE_REPLACEMENT.md.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
// @babel/core + the presets are LAZY-loaded (see loadBabel below). The common
// React native-JSX path never runs Babel, and loading @babel/core + 3 presets
// eagerly added ~0.3–0.5 s to `carbon build` startup. Deferring them keeps that
// out of the hot path. Solid and the babel-JSX fallback load them on demand.
// Direct relative imports into the workspace plugin packages. We don't go
// through `exports` because the carbon-tailwind / carbon-transforms packages
// keep `"main": "./src/index.ts"` (Vite-shaped) and we just want the babel
// counterpart sitting alongside.
import { carbonTailwindBabel } from "@carbon/vite/tailwind/babel";
import { setThemeTokens, getThemeTokens } from "@carbon/vite/tailwind/classes";
import { loadProjectThemeTokens } from "@carbon/vite/tailwind/theme-extractor";
// Hash the class-resolver source too so changes to classes.ts (where the
// Tailwind subset table lives) invalidate the babel-output cache. Without
// this, adding shadcn tokens to classes.ts wouldn't bust the per-file cache.
import { readFileSync as _carbonReadSync } from "node:fs";
// Both of these are resolved in @carbon/toolchain/paths rather than by counting
// `../` hops from this file. They used to be `new URL("../../…")`, which meant
// every directory move broke them silently — and only on the code paths that
// actually read them, so a build of one example could pass while another died.
import {
  TAILWIND_CLASSES_SRC,
  CSS_ENGINE_SRC,
  MINI_REACT_SRC,
  MINI_SOLID_SRC,
  COMPAT_DOM_INSTALL_SRC,
  COMPAT_DOM_SRC,
} from "@carbon/workspace";
const _carbonClassesPath = TAILWIND_CLASSES_SRC;
// Absolute path to the native CSS engine — generated .css modules import it,
// and they live deep in node_modules where the bare specifier
// "@carbon/compat-dom/css" won't resolve.
const _carbonCssEnginePath = CSS_ENGINE_SRC.replace(/\\/g, "/");
const CARBON_TAILWIND_CLASSES_SOURCE = (() => {
  try { return _carbonReadSync(_carbonClassesPath, "utf8"); }
  catch { return ""; }
})();
import { makeCarbonCssBabel } from "@carbon/babel/css";
import { carbonTransformsBabel } from "@carbon/vite/transforms/babel";
// Build-time plugins authored as Vite plugins; we re-use their resolveId/load
// hooks against Bun.build via the small adapter below. This keeps a single
// source of truth for the carbon:* virtual module mapping + capability check
// across both the Vite path (used by other backends) and the Bun.build path
// (used by mini today).
import { carbonImports } from "@carbon/vite/imports";
import { carbonAssets } from "@carbon/vite/assets";
import { carbonDev } from "@carbon/vite/dev";
// carbonFastImport: Vite-shaped plugin that rewrites named imports from
// 'three' (Vector3, Matrix4, …) to come from 'carbon-fast-math'. We run it
// in the Bun.build path too — registered as a Vite-shaped transform that
// fires BEFORE Babel inside the carbon-babel onLoad below. Gated on the
// project actually depending on three OR carbon-fast-math (skipped
// otherwise so unrelated apps don't pay the regex scan).
import { carbonFastImport } from "@carbon/vite/fast-import";
import { transformCarbonAppDecorator } from "@carbon/babel/app-decorator";
// carbonThreeBridgeBabel: Babel plugin that lifts <Canvas> subtrees so JSX
// nested inside compiles for the three-fiber renderer rather than the
// outer carbon-mini moduleName. Runs in phase 1, BEFORE babel-preset-solid.
import carbonThreeBridgeBabel from "@carbon/vite/three-bridge/babel";
import { log } from "@carbon/logging";

// Lazily populated by loadBabel(). Kept as mutable module-level bindings so the
// existing onLoad / signature code reads them unchanged once loaded.
let transformSync: any = null;
let solidPreset: any = null;
let reactPreset: any = null;
let tsPreset: any = null;
let _babelLoaded = false;
async function loadBabel(): Promise<void> {
  if (_babelLoaded) return;
  const [core, solidMod, reactMod, tsMod] = await Promise.all([
    import("@babel/core"),
    import("babel-preset-solid"),
    import("@babel/preset-react"),
    import("@babel/preset-typescript"),
  ]);
  transformSync = (core as any).transformSync;
  solidPreset = (solidMod as any).default ?? solidMod;
  reactPreset = (reactMod as any).default ?? reactMod;
  tsPreset = (tsMod as any).default ?? tsMod;
  _babelLoaded = true;
}

// Resolve dependency versions ONCE at module load (cheap; lets us avoid
// require() on every cache lookup). Falls back to "unknown" so a missing
// package.json doesn't crash the pipeline — the cache key just becomes a
// little less precise.
function safeRequireVersion(name: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(`${name}/package.json`);
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
const BABEL_CORE_VERSION = safeRequireVersion("@babel/core");
const SOLID_PRESET_VERSION = safeRequireVersion("babel-preset-solid");

// Stable signatures of our two phase configs. Plugin functions are not
// JSON-serializable, so we hash their .toString() — when the plugin source
// changes (across upgrades, patches, our own edits) the signature changes
// and every cached entry for that phase invalidates.
//
// NOTE: phase 1 also depends on whether the three-bridge plugin is active
// for this project. We fold that bit into the per-build cache key (see
// `phase1SignatureFor`) rather than the module-load constant — different
// projects share the same CLI binary but have different dep sets.
const PHASE1_BASE_SIG = createHash("sha256")
  .update("phase1\n")
  .update(`carbonTransformsBabel:${carbonTransformsBabel.toString()}\n`)
  .update(`carbonTailwindBabel:${carbonTailwindBabel.toString()}\n`)
  .update(`carbonTailwindClasses:${CARBON_TAILWIND_CLASSES_SOURCE}\n`)
  .update(`carbonThreeBridgeBabel:${carbonThreeBridgeBabel.toString()}\n`)
  .update(`carbonAppDecorator:${transformCarbonAppDecorator.toString()}\n`)
  .digest("hex")
  .slice(0, 16);

function phase1SignatureFor(useThreeBridge: boolean, cssHash: string): string {
  return createHash("sha256")
    .update(PHASE1_BASE_SIG)
    .update(`\nthreeBridge=${useThreeBridge ? "1" : "0"}`)
    .update(`\ncssHash=${cssHash}`)
    .digest("hex")
    .slice(0, 16);
}

// Read the project's package.json once per build to decide which optional
// plugins to wire (three-bridge, fast-import). Returns an empty object on
// any read/parse failure — we treat absence as "no deps" rather than
// failing the build.
function readProjectDeps(projectDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(projectDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
  } catch {
    return {};
  }
}

// MAX_FILES: pruning threshold. ~2000 entries × ~10 KB avg ≈ 20 MB on disk;
// well under any reasonable disk budget but high enough that medium projects
// (~200 files × 2 phases = 400 entries) never trigger pruning.
const MAX_FILES = 2000;
// PRUNE_EVERY: amortize the directory walk. Once every N writes we check
// the entry count and trim oldest-by-mtime if over MAX_FILES.
const PRUNE_EVERY = 100;

export interface BunBabelBuildOptions {
  /** Project root containing the entry file. */
  projectDir: string;
  /** Entry file path relative to projectDir (e.g. "counter.tsx"). */
  entry: string;
  /** Output bundle path (relative to projectDir). Default: "dist/bundle.js". */
  outFile?: string;
  /** Options forwarded to babel-preset-solid. Ignored when framework="react". */
  solid?: { generate?: "dom" | "ssr" | "universal"; moduleName?: string };
  /** UI framework: which JSX preset to run, and whether to auto-inject the
   *  DOM shim. Auto-detected from the project's package.json deps when
   *  omitted: `react` in deps → "react"; otherwise → "solid". */
  framework?: "solid" | "react";
  /** Verbose timings + per-file Babel call count. */
  debug?: boolean;
  /** Disable the per-file Babel cache (re-run Babel on every file). */
  noBabelCache?: boolean;
  /**
   * Wrap the bundle body in an IIFE so re-eval in the SAME JS context is
   * safe. Only needed for the HMR-with-bytecode path: the runtime's .js
   * eval already adds its own IIFE wrapper, but the bytecode path
   * (JS_EvalFunction) runs the compiled script directly, so a second eval
   * of a bundle with top-level `const`/`let` throws "redeclaration of X".
   *
   * Costs cold-start speed (QuickJS executes one giant function ~3× slower
   * than top-level scope: ~700 ms → ~2000 ms eval), so production builds
   * leave this OFF and only `carbon dev` turns it ON.
   */
  wrapIife?: boolean;
  /** Vendor/app split: bare specifiers to externalize from the app bundle
   *  (resolved at runtime from the vendor registry). */
  external?: string[];
  /** Output format. "cjs" (split app bundle) makes externals become require()
   *  calls; default "esm" (self-contained single bundle). */
  format?: "esm" | "cjs";
  /** Prepend a `globalThis.require` shim that resolves externals from the
   *  vendor registry (`globalThis.__cm_vendor_reg`). For split app bundles. */
  requireShim?: boolean;
}

interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
}

interface BabelCache {
  enabled: boolean;
  dir: string;
  stats: CacheStats;
  /** Bumped on every write — used to pace prune sweeps. */
  writesSinceLastPrune: number;
}

/** Stable signature for phase 2 (depends on solid options chosen at call-time). */
function phase2Signature(solidOpts: any): string {
  return createHash("sha256")
    .update("phase2\n")
    .update(`solidPreset:${solidPreset.toString().slice(0, 4096)}\n`)
    .update(`solidOpts:${JSON.stringify(solidOpts ?? {})}\n`)
    .digest("hex")
    .slice(0, 16);
}

/** Phase-2 cache signature for the React path — different preset, different
 *  options, different cache namespace so we don't poison entries when a
 *  project switches frameworks. */
function phase2SignatureReact(reactOpts: any): string {
  return createHash("sha256")
    .update("phase2-react\n")
    .update(`reactPreset:${reactPreset.toString().slice(0, 4096)}\n`)
    .update(`tsPreset:${tsPreset.toString().slice(0, 4096)}\n`)
    .update(`reactOpts:${JSON.stringify(reactOpts ?? {})}\n`)
    .digest("hex")
    .slice(0, 16);
}

/** Per-file cache key: content + filename + phase config + tool versions. */
function cacheKey(
  source: string,
  filename: string,
  phase: "phase1" | "phase2",
  phaseSig: string,
): string {
  return createHash("sha256")
    .update(`v1\n`)
    .update(`babel=${BABEL_CORE_VERSION}\n`)
    .update(`solid=${SOLID_PRESET_VERSION}\n`)
    .update(`phase=${phase}\n`)
    .update(`phaseSig=${phaseSig}\n`)
    // Filename matters: Babel reports it in errors and some plugins (not
    // ours, but defensive) read state.filename. Keeping it in the key means
    // a moved file gets its own entry rather than a phantom hit.
    .update(`file=${filename}\n`)
    .update(`src:`)
    .update(source)
    .digest("hex");
}

function ensureCacheDir(projectDir: string): string {
  const dir = join(projectDir, ".carbon-cache", "babel");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function tryReadCache(cache: BabelCache, key: string): string | null {
  if (!cache.enabled) return null;
  const path = join(cache.dir, `${key}.js`);
  try {
    const buf = readFileSync(path);
    cache.stats.hits++;
    return buf.toString("utf8");
  } catch {
    cache.stats.misses++;
    return null;
  }
}

function writeCacheEntry(cache: BabelCache, key: string, code: string): void {
  if (!cache.enabled) return;
  const path = join(cache.dir, `${key}.js`);
  try {
    writeFileSync(path, code);
    cache.stats.writes++;
    cache.writesSinceLastPrune++;
    if (cache.writesSinceLastPrune >= PRUNE_EVERY) {
      cache.writesSinceLastPrune = 0;
      pruneIfOverMax(cache.dir);
    }
  } catch {
    // Cache writes are best-effort — if the disk is full or the cache dir
    // got nuked between mkdir and write we just keep going (no hit next
    // time, no harm done).
  }
}

/**
 * Prune entries oldest-by-mtime once we exceed MAX_FILES. Cheap: a single
 * readdir + stat per entry. Skips silently on any error (cache is best-
 * effort by design).
 */
function pruneIfOverMax(dir: string): void {
  try {
    const entries = readdirSync(dir);
    if (entries.length <= MAX_FILES) return;
    const stats = entries
      .filter((n) => n.endsWith(".js"))
      .map((n) => {
        try {
          const st = statSync(join(dir, n));
          return { name: n, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; mtimeMs: number } => x !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = stats.length - MAX_FILES;
    if (toRemove <= 0) return;
    for (let i = 0; i < toRemove; i++) {
      try {
        unlinkSync(join(dir, stats[i].name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

// ── Vite-plugin → Bun.build adapter ────────────────────────────────────
//
// The @carbon/vite/imports / -assets / -dev plugins are written
// against the Vite plugin shape (`resolveId(source)`, `load(id)`, and
// `transform(code, id)`). Bun.build uses a different shape (`onResolve`,
// `onLoad`). We bridge them here rather than maintaining two
// implementations of each plugin: there's no per-call overhead worth
// worrying about (each onLoad fires once per module, the work each plugin
// does is microseconds).
//
// Adapter contract:
//   - resolveId is invoked for every `onResolve`; if it returns a string
//     starting with `\0`, we route the load through the same plugin's
//     `load` hook (Bun's `onLoad` filter intercepts the namespace path).
//   - load returns either a string (treated as JS source) or `{ code }`.
//   - transform runs after Bun reads + Babel transforms a real file, but
//     before the file is handed back to Bun's bundler. We currently only
//     wire transform for `carbonDev` because that's the only plugin in
//     this set that relies on it.
//
// What we deliberately don't support: Vite's `enforce: 'pre'/'post'`
// ordering inside Bun.build. We rely on the fact that the three plugins
// don't need to interleave — imports + assets are pure resolution-time
// concerns, and dev injection happens at transform time.

interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
  configResolved?: (cfg: { command: string; root: string }) => void | Promise<void>;
  resolveId?: (
    this: { error: (msg: string) => never },
    source: string,
    importer?: string,
  ) => string | null | undefined;
  load?: (
    id: string,
  ) => string | { code: string; map?: any } | null | undefined;
  transform?: (
    code: string,
    id: string,
  ) => string | { code: string; map?: any } | null | undefined;
}

/**
 * Make Bun.build plugins from a list of Vite-shaped plugins.
 *
 * For every plugin we register one or two Bun setup blocks:
 *   - onResolve covers `resolveId` (intercepts virtual specifiers).
 *   - onLoad with namespace 'carbon-virtual' serves the virtual module
 *     bodies returned from `load`.
 *
 * `onResolve` is filtered to the `carbon:*` prefix where possible so we
 * don't pay a function-call cost on every import. The load filter is
 * always-on because Bun's namespaces give us free dispatch.
 */
function adaptVitePluginsForBun(
  plugins: VitePluginLike[],
  projectDir: string,
): Bun.BunPlugin[] {
  // Fire configResolved for each plugin; we synthesize a Vite-ish config
  // object containing only what our plugins read today (`command`, `root`).
  for (const p of plugins) {
    if (typeof p.configResolved === "function") {
      try {
        p.configResolved({
          command: process.env.CARBON_DEV === "1" ? "serve" : "build",
          root: projectDir,
        });
      } catch (e: any) {
        log.warn(`[${p.name}] configResolved failed: ${e?.message ?? e}`);
      }
    }
  }

  // Bun's onResolve doesn't take a function-only filter — it takes a
  // RegExp. Match `carbon:foo`, `carbon:foo/bar` and the rollup-virtual
  // form `\0carbon-...`.
  const CARBON_SPEC_RE = /^carbon:[A-Za-z0-9_-]+(?:\/.*)?$/;

  const out: Bun.BunPlugin[] = [];

  // Single resolver block: walks the plugin list in order, asking each one
  // whether it claims the specifier. The first non-null wins.
  out.push({
    name: "carbon-vite-adapter:resolve",
    setup(b) {
      b.onResolve({ filter: CARBON_SPEC_RE }, (args) => {
        for (const p of plugins) {
          if (typeof p.resolveId !== "function") continue;
          let resolved: string | null | undefined;
          try {
            resolved = p.resolveId.call(
              {
                // Vite's `this.error(msg)` throws — we mirror that so the
                // capability-check error propagates as a build failure.
                error(msg: string): never {
                  throw new Error(msg);
                },
              },
              args.path,
              args.importer,
            );
          } catch (e: any) {
            return Promise.reject(new Error(e?.message ?? String(e))) as any;
          }
          if (typeof resolved === "string" && resolved.length > 0) {
            // Stash the original id (without the `\0` prefix) in path; use
            // a custom namespace so the load hook recognises it.
            return { path: resolved, namespace: "carbon-virtual" };
          }
        }
        return undefined;
      });

      b.onLoad({ filter: /.*/, namespace: "carbon-virtual" }, (args) => {
        for (const p of plugins) {
          if (typeof p.load !== "function") continue;
          let loaded: string | { code: string } | null | undefined;
          try {
            loaded = p.load(args.path);
          } catch (e: any) {
            return Promise.reject(new Error(e?.message ?? String(e))) as any;
          }
          if (loaded == null) continue;
          const contents = typeof loaded === "string" ? loaded : loaded.code;
          return { contents, loader: "js" };
        }
        // No plugin claimed this — emit a stub so we don't crash with
        // "namespace handler returned nothing".
        return { contents: `// unresolved carbon virtual: ${args.path}\n`, loader: "js" };
      });
    },
  });

  // Per-plugin `transform` is NOT registered as a separate Bun.build
  // plugin: Bun's onLoad runs only the first matching handler, so we'd
  // collide with the carbon-babel onLoad for `.tsx` files. The caller
  // (carbon-babel onLoad) is responsible for invoking
  // `runVitePluginTransforms(plugins, code, path)` after its own work
  // completes — see the integration in buildBundleWithBabel below.
  return out;
}

/**
 * Run every Vite-shaped plugin's `transform` hook in order, returning the
 * accumulated code. Used by carbon-babel's onLoad to chain dev-plugin
 * transforms after the Babel passes.
 */
function runVitePluginTransforms(
  plugins: VitePluginLike[],
  code: string,
  id: string,
): string {
  let out = code;
  for (const p of plugins) {
    if (typeof p.transform !== "function") continue;
    let res: string | { code: string } | null | undefined;
    try {
      res = p.transform(out, id);
    } catch {
      continue;
    }
    if (res == null) continue;
    out = typeof res === "string" ? res : res.code;
  }
  return out;
}

/**
 * Build a single-bundle ESM at <projectDir>/<outFile> using bun-build chained
 * with our Babel transforms. Returns the absolute output path on success.
 */
export async function buildBundleWithBabel(
  opts: BunBabelBuildOptions,
): Promise<string> {
  const { projectDir, entry } = opts;
  const outFileRel = opts.outFile ?? "dist/bundle.js";
  const solidOpts = opts.solid ?? {
    generate: "universal",
    moduleName: "@carbon/mini-solid",
  };

  const entryAbs = join(projectDir, entry);
  if (!existsSync(entryAbs)) {
    throw new Error(`buildBundleWithBabel: entry not found at ${entryAbs}`);
  }

  // Framework detection: explicit opts > package.json deps > "solid".
  // The React adapter (@carbon/mini-react) is selected when the project
  // depends on `react` and not on `solid-js`. Mixed projects must pass
  // `framework` explicitly to disambiguate.
  const detectedFramework: "solid" | "react" = (() => {
    if (opts.framework) return opts.framework;
    const d = readProjectDeps(projectDir);
    if ("react" in d && !("solid-js" in d)) return "react";
    return "solid";
  })();

  // Theme tokens: parse the project's `globals.css` (or equivalent)
  // and inject `:root` design tokens into the Tailwind class compiler.
  // Without this every `bg-background` / `text-muted-foreground` / etc.
  // resolves to the hardcoded fallback palette in `classes.ts` —
  // which is shadcn's stock light theme, NOT the project's. terax-ai
  // and similar apps redefine these in their own CSS; if we don't
  // read them we render the wrong colors. Done once per build.
  try {
    // Theme mode: read from carbon.toml's [theme] block when present
    // (e.g. shadcn-default apps that ship dark-first). Defaults to
    // "light" to match the most-common landing-page case. Light-on-
    // light apps that have :root = oklch(1 0 0) and rely on `.dark`
    // for any colored chrome (terax, most shadcn dashboards) MUST
    // declare [theme] mode = "dark" in carbon.toml or the engine
    // resolves every `bg-card` / `bg-background` to white and the
    // window renders blank.
    let themeMode: "light" | "dark" = "light";
    try {
      const tomlPath = join(projectDir, "carbon.toml");
      if (await Bun.file(tomlPath).exists()) {
        const tomlSrc = await Bun.file(tomlPath).text();
        const m = /\[theme\][\s\S]*?mode\s*=\s*"(light|dark)"/.exec(tomlSrc);
        if (m) themeMode = m[1] as "light" | "dark";
      }
    } catch { /* fall through to default */ }
    const projectTokens = loadProjectThemeTokens(projectDir, themeMode);
    if (Object.keys(projectTokens).length > 0) {
      setThemeTokens(projectTokens);
    }
  } catch (e: any) {
    log.warn(`[carbon-tailwind] theme extraction failed: ${e?.message ?? e}`);
  }
  const reactOpts = {
    runtime: "automatic" as const,
    importSource: "@carbon/mini-react",
    development: false,
  };

  // React path: skip Babel's phase-2 (@babel/preset-react + preset-typescript)
  // and let Bun's native tsx loader do the JSX transform + type stripping.
  // The project's tsconfig (jsx: "react-jsx") makes Bun emit react/jsx-runtime
  // jsx() calls, and @carbon/mini-react/jsx-runtime just RE-EXPORTS those — so
  // the output is identical, but the cold build is ~2× faster (Babel's heaviest
  // pass is gone). The reconciler lives at the render layer (react-dom shim →
  // @carbon/mini-react), not the JSX factory, so behavior is unchanged. Solid
  // still needs Babel (the universal preset has no native equivalent). Opt out
  // with CARBON_USE_BABEL_JSX=1.
  const useNativeJsx =
    detectedFramework === "react" && process.env.CARBON_USE_BABEL_JSX !== "1";

  // Per-file transform counters (printed in --debug only).
  let filesTransformed = 0;
  let babelMs = 0;

  // Set NODE_ENV before invoking Bun.build so solid-js's `exports` condition
  // map prefers its production build (which Vite's prod build also uses).
  // Done once globally; harmless to repeat.
  process.env.NODE_ENV = "production";

  mkdirSync(join(projectDir, "dist"), { recursive: true });

  // Set up the Babel cache (per-project, on disk). Disabled on
  // --no-babel-cache or when CARBON_NO_BABEL_CACHE=1 is set in the env (the
  // env var lets us measure without rebuilding the CLI).
  const cacheEnabled =
    !opts.noBabelCache && process.env.CARBON_NO_BABEL_CACHE !== "1";
  const cache: BabelCache = {
    enabled: cacheEnabled,
    dir: cacheEnabled ? ensureCacheDir(projectDir) : "",
    stats: { hits: 0, misses: 0, writes: 0 },
    writesSinceLastPrune: 0,
  };
  // Computed after we know whether Babel will run (and after loadBabel, since
  // the signature hashes the preset source). Left empty on the React
  // native-JSX path, where phase-2 caching is bypassed entirely.
  let phase2Sig = "";

  if (opts.debug) {
    log.step(`framework: ${detectedFramework}`);
  }

  // Conditional plugins — gated on the project's package.json deps so we
  // don't pay the regex/AST cost for projects that won't benefit. Both
  // checks are cheap (one fs read + JSON.parse) and happen once per build.
  const projectDeps = readProjectDeps(projectDir);
  const useThreeBridge =
    "@carbon/three-fiber" in projectDeps ||
    "@carbon/three" in projectDeps;
  const useFastImport =
    "three" in projectDeps || "carbon-fast-math" in projectDeps;

  if (opts.debug) {
    if (useThreeBridge) log.step(`carbon-three-bridge: enabled`);
    if (useFastImport) log.step(`carbon-fast-import: enabled`);
  }

  // Phase-1 babel plugin chain. The three-bridge plugin must run BEFORE
  // carbon-tailwind/carbon-transforms aren't strictly ordering-sensitive
  // here, but we put three-bridge first to keep its lifted r3fBuild prop
  // out of the way of subsequent visitors.
  //
  // carbon-css runs BEFORE carbon-tailwind so user-defined `styles.css`
  // class names resolve first; anything left over (treated as Tailwind
  // utility classes) gets handled by the Tailwind plugin. Both plugins
  // remove the `class` attr only when they fully resolve everything in it.
  const phase1Plugins: any[] = [];
  if (useThreeBridge) {
    phase1Plugins.push(carbonThreeBridgeBabel);
  }
  // Hash styles.css contents (if any) to fold into the cache key —
  // editing styles.css must invalidate the per-file babel cache.
  let cssHash = "no-css";
  const cssPath = join(projectDir, "styles.css");
  try {
    if (existsSync(cssPath)) {
      cssHash = createHash("sha256")
        .update(readFileSync(cssPath))
        .digest("hex")
        .slice(0, 16);
    }
  } catch {
    /* fall through with cssHash = no-css */
  }

  const carbonCssBabel = makeCarbonCssBabel(projectDir);
  if (carbonCssBabel) {
    phase1Plugins.push(carbonCssBabel);
    if (opts.debug) log.step(`carbon-css: enabled (styles.css found)`);
  }
  // React native-JSX path: tailwind classes resolve at RUNTIME via
  // __cm_resolve_class (installed + theme-seeded in the entry prelude), so the
  // build-time class→style Babel pass is redundant. Console-strip is a
  // release-only concern (handled by the release profile, not the hot build).
  // Dropping both lets terax-style React apps skip Babel's phase-1 ENTIRELY —
  // the single biggest cold-build cost. Solid / babel-JSX keep the full chain.
  if (!useNativeJsx) {
    phase1Plugins.push(carbonTransformsBabel, carbonTailwindBabel);
  }
  const phase1Sig = phase1SignatureFor(useThreeBridge, cssHash);

  // Load Babel only if a pass will actually run: any phase-1 plugin (three
  // bridge / styles.css / Solid+React full chain), or the babel-JSX phase-2
  // (everything except the React native-JSX path). terax (React, no three, no
  // styles.css) hits neither → Babel is never imported.
  const willUseBabel = phase1Plugins.length > 0 || !useNativeJsx;
  if (willUseBabel) {
    await loadBabel();
    phase2Sig =
      detectedFramework === "react"
        ? phase2SignatureReact(reactOpts)
        : phase2Signature(solidOpts);
  }

  // Build the carbon Vite-shaped plugin chain. The order matters:
  //   1. carbonFastImport  — `import { Vector3 } from 'three'` rewrite
  //                          (transform hook only; no resolveId/load).
  //                          MUST run BEFORE Babel so the rewritten import
  //                          is what Bun's bundler sees.
  //   2. carbonImports     — `carbon:*` virtual modules + capability check
  //   3. carbonAssets      — shader/text inline + image URL pass-through
  //   4. carbonDev         — dev-only injection (no-op without CARBON_DEV=1)
  //
  // The adapter routes resolveId/load through Bun.build's onResolve/onLoad
  // (so `carbon:*` and shader imports work). The transform hooks below are
  // invoked manually from the carbon-babel onLoad — fast-import as a PRE
  // pass before phase-1 Babel, the others as a POST pass after phase-2.
  const fastImportPlugin: VitePluginLike | null = useFastImport
    ? (carbonFastImport() as unknown as VitePluginLike)
    : null;
  // Fire the fast-import plugin's `configResolved` once (mirrors what the
  // adapter does for the others).
  if (fastImportPlugin && typeof fastImportPlugin.configResolved === "function") {
    try {
      fastImportPlugin.configResolved({
        command: process.env.CARBON_DEV === "1" ? "serve" : "build",
        root: projectDir,
      });
    } catch (e: any) {
      log.warn(`[carbon-fast-import] configResolved failed: ${e?.message ?? e}`);
    }
  }

  const carbonPlugins: VitePluginLike[] = [
    carbonImports() as unknown as VitePluginLike,
    carbonAssets() as unknown as VitePluginLike,
    carbonDev() as unknown as VitePluginLike,
  ];
  const adapterPlugins = adaptVitePluginsForBun(carbonPlugins, projectDir);

  const t0 = performance.now();
  const result = await Bun.build({
    entrypoints: [entryAbs],
    outdir: join(projectDir, "dist"),
    naming: { entry: outFileRel.replace(/^dist\//, "") },
    target: "browser",
    // Split builds emit the app bundle as CJS with node_modules externalized;
    // the externals become require() calls resolved at runtime from the vendor
    // registry (see the require shim prepended below). Default is ESM.
    format: (opts.format ?? "esm") as "esm" | "cjs",
    external: opts.external ?? [],
    // Minify by default; disable when CARBON_DEBUG_BUILD=1 so apps
    // bringing up new ports get readable symbols in stack traces.
    minify: !process.env.CARBON_DEBUG_BUILD,
    // Release builds (`carbon build --release`) drop console.* + debugger from
    // the production bundle natively — this is the console-strip that used to
    // live in carbon-transforms-babel, now done by Bun for free (no Babel pass).
    // Dev keeps them so logs/devtools work.
    drop: process.env.CARBON_RELEASE === "1" ? ["console", "debugger"] : [],
    conditions: ["production"],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
    },
    plugins: [
      // Adapter plugins (resolveId/load for carbon:* virtual modules and
      // shader/text imports) run BEFORE the babel onLoad — Bun resolves
      // the import graph using these resolvers, so the synthetic modules
      // never reach the Babel pass.
      ...adapterPlugins,
      // CSS imports — apps coming from a Vite/PostCSS world use
      // `import "./styles.css"` and `import "tailwindcss"`. Bun's
      // built-in CSS parser doesn't understand Tailwind v4's at-rules
      // (`@utility`, `@theme`, `@tailwind`). We intercept all CSS
      // imports and resolve them as empty modules — the actual
      // styling pipeline runs through @carbon/vite/tailwind's
      // class-to-style transform on JSX, plus a runtime stylesheet
      // engine that picks up `@theme` design tokens from the original
      // CSS source separately.
      {
        name: "carbon-css-noop",
        setup(b) {
          // Resolve the .css specifier to an absolute path so onLoad can read
          // the file. App CSS (src/) is no-op'd (its utilities flow through
          // the Tailwind class resolver). PACKAGE stylesheets (node_modules —
          // e.g. xterm.css) carry author rules the runtime CSS engine must
          // apply (canvas-layer positioning, scrollbars, viewport), so we
          // register them with @carbon/compat-dom's stylesheet engine.
          b.onResolve({ filter: /\.css$/ }, (args) => {
            let resolved = args.path;
            try {
              const dir = (args as any).resolveDir
                || (args.importer ? args.importer.replace(/[\\/][^\\/]*$/, "") : projectDir);
              resolved = Bun.resolveSync(args.path, dir);
            } catch { /* keep specifier */ }
            return { path: resolved, namespace: "carbon-css-noop" };
          });
          b.onLoad({ filter: /.*/, namespace: "carbon-css-noop" }, async (args) => {
            if (!args.path.includes("node_modules")) {
              return { contents: "export default {};", loader: "js" as const };
            }
            let css = "";
            try { css = await Bun.file(args.path).text(); } catch { /* ignore */ }
            return {
              contents:
                `import { registerStylesheet as __cm_register_stylesheet } from ${JSON.stringify(_carbonCssEnginePath)};\n` +
                `__cm_register_stylesheet(${JSON.stringify(css)});\nexport default {};`,
              loader: "js" as const,
            };
          });
        },
      },
      // react-dom redirect. React apps that mount via
      // `import ReactDOM from "react-dom/client"` need our scene-graph
      // reconciler instead of the real react-dom (which renders to a
      // DOM). We resolve react-dom/client and react-dom to
      // @carbon/mini-react so the entry's createRoot call lands in
      // our exported shim. This keeps the app's main.tsx unchanged.
      {
        name: "carbon-react-dom-shim",
        setup(b) {
          // Resolve to the repo path, NOT the app's node_modules. Bun's
          // isolated linker gives each package only what its own
          // package.json declares, and an app never declares the reconciler
          // — the pipeline injects it. Going through
          // `<app>/node_modules/@carbon/mini-react` worked only while the
          // installer hoisted everything to one root node_modules.
          b.onResolve({ filter: /^react-dom(?:\/client)?$/ }, () => {
            return { path: MINI_REACT_SRC };
          });
          // Same reasoning for the DOM-compat shim and the runtime Tailwind
          // class resolver: injected by the pipeline, never declared by the
          // app, so they resolve from the repo.
          b.onResolve({ filter: /^@carbon\/compat-dom\/install$/ }, () => {
            return { path: COMPAT_DOM_INSTALL_SRC };
          });
          b.onResolve({ filter: /^@carbon\/compat-dom$/ }, () => {
            return { path: COMPAT_DOM_SRC };
          });
          b.onResolve({ filter: /^@carbon\/vite-tailwind\/classes$/ }, () => {
            return { path: _carbonClassesPath };
          });
          // @carbon/mini-solid is the moduleName babel-preset-solid compiles
          // every JSX element against, so it MUST resolve — but a scaffolded
          // project cannot depend on it the ordinary way.
          //
          // A `file:` dependency is what V1 generated, and it does not work
          // here: bun walks up from the dependency, finds the node_modules
          // JUNCTION at the workspace root (the real tree lives in .config/),
          // and the copy fails with EPERM on Windows. Reproduced in isolation —
          // a plain directory works, the same package under a junction does
          // not.
          //
          // So the renderer is injected, exactly like the reconciler and the
          // DOM shim above: resolved from the workspace, never installed into
          // the app.
          b.onResolve({ filter: /^@carbon\/mini-solid$/ }, () => {
            return { path: MINI_SOLID_SRC };
          });
          b.onResolve({ filter: /^@carbon\/mini-solid\/polyfills$/ }, () => {
            return { path: join(dirname(MINI_SOLID_SRC), "polyfills.ts") };
          });
          b.onResolve({ filter: /^@carbon\/mini-solid\/image$/ }, () => {
            return { path: join(dirname(MINI_SOLID_SRC), "image-intrinsic.ts") };
          });
        },
      },
      // NOTE: xterm.js runs UNMODIFIED now — no shim. Real @xterm/xterm +
      // addons resolve to their npm packages and render through the native
      // DOM layer (@carbon/compat-dom: layout reads via __cm_layout_box) plus
      // the native CanvasRenderingContext2D (canvas2d.rs). xterm.css's author
      // rules (canvas-layer positioning etc.) are applied to the scene graph
      // by the native CSS engine — registered via the carbon-css-noop loader
      // above, which now feeds package stylesheets to @carbon/compat-dom/css.
      {
        name: "carbon-babel",
        setup(b) {
          b.onLoad({ filter: /\.(tsx|jsx|ts|js|ctsx)$/ }, async (args) => {
            // node_modules: pass through (no transforms — costs >100ms over
            // the solid-js + jsx-dom-expressions sub-graph if Babel touched
            // them, and they emit no JSX of their own at runtime).
            if (args.path.includes("node_modules")) return undefined;

            const t1 = performance.now();
            let src = await Bun.file(args.path).text();

            // PRE-PRE pass: @CarbonApp directive. Runs on `.ctsx`
            // files (carbon's custom DSL extension) AND on the entry
            // file regardless of extension. Strips the directive line
            // and appends a `mount(() => <Name />)` call. After this
            // pass the source is a normal TSX module — Bun's loader
            // hint below maps `.ctsx` → tsx so Babel + Solid handle
            // it exactly like a regular TSX file.
            if (args.path === entryAbs || args.path.endsWith(".ctsx")) {
              const r = transformCarbonAppDecorator(src);
              if (r.entry !== null) {
                src = r.code;
              }
            }

            // Entry-only React preludes (build-time injection so the
            // app's source doesn't need to import them itself):
            //
            //   1. `@carbon/compat-dom/install` — installs document /
            //      window / Streams / URL / TextEncoder / etc. as
            //      globals BEFORE the bundle evaluates. React-DOM,
            //      tailwind class wiring, AI-SDK streaming, every
            //      modern lib expects these. Without this prepend a
            //      React app reverts to "TransformStream is not
            //      defined" at module-init.
            //
            // Skipped when the file already imports the install module
            // (don't double-inject) and when framework != "react".
            if (
              args.path === entryAbs &&
              detectedFramework === "react" &&
              !/carbon-dom-shim\/install/.test(src)
            ) {
              src = `import "@carbon/compat-dom/install";\n${src}`;
            }

            // Install the runtime Tailwind resolver before the React
            // root mounts. @carbon/mini-react/applyProps probes for
            // `globalThis.__cm_resolve_class` per className token; if
            // present each class resolves to inline styles, picking up
            // the cva/cn-generated strings that the static babel pass
            // can't see at build time.
            if (
              args.path === entryAbs &&
              detectedFramework === "react" &&
              !/__cm_install_class_resolver/.test(src)
            ) {
              // ALSO seed the runtime resolver's token table with the
              // project's actual theme palette. Without this, the bundle's
              // copy of classes.ts boots with shadcn's LIGHT default
              // palette — every `bg-background` / `bg-card` looked up at
              // runtime (via cva / cn / dynamic className concat) resolves
              // to white, regardless of what the .dark / :root block in
              // the project's CSS says. We serialise the build-time
              // tokens into a setThemeTokens() call at the top of the
              // bundle so the runtime resolver matches what the babel
              // pass already baked into static className strings.
              const tokens = getThemeTokens();
              const tokensJson = JSON.stringify(tokens);
              console.error(`[carbon-tailwind] injecting runtime tokens into entry: ${Object.keys(tokens).length} keys, bg=${tokens.background ?? "(missing)"}, card=${tokens.card ?? "(missing)"}`);
              src = `import { resolveTailwindClass as __cm_install_class_resolver, setThemeTokens as __cm_set_theme_tokens } from "@carbon/vite/tailwind/classes";\n__cm_set_theme_tokens(${tokensJson});\n(globalThis).__cm_resolve_class = __cm_install_class_resolver;\n${src}`;
            }



            // PRE pass: carbon-fast-import. Runs BEFORE Babel so the
            // rewritten `import { Vector3 } from 'carbon-fast-math'` is
            // what Bun's bundler resolves. Idempotent (the plugin
            // returns null on files with nothing to rewrite). Not
            // separately cached — its work is regex-light and folds into
            // phase 1's cache key via the source bytes.
            if (fastImportPlugin && typeof fastImportPlugin.transform === "function") {
              try {
                const r = fastImportPlugin.transform(src, args.path);
                if (r != null) {
                  src = typeof r === "string" ? r : r.code;
                }
              } catch (e: any) {
                log.warn(`[carbon-fast-import] transform threw on ${args.path}: ${e?.message ?? e}`);
              }
            }

            // Three-pass Babel:
            //   Pass A: our plugins. They mutate JSXAttribute nodes and
            //           — when three-bridge is active — lift Canvas
            //           subtrees into builder functions. We have to do
            //           this BEFORE the Solid preset because babel-
            //           plugin-jsx-dom-expressions replaces JSXElement on
            //           enter, preventing visitors from reaching the
            //           inner attrs in the same pass.
            //   Pass B: babel-preset-solid (universal). Compiles JSX →
            //           calls into @carbon/mini-solid.
            // Each pass is independently cached: if only the source
            // content touches `class=...` (phase 1's domain) and not JSX
            // shape we STILL re-run phase 2 because phase 1's output
            // bytes change. That's fine — we still skip phase 1 for
            // every untouched file.
            //
            // For warm-cache, no-edit rebuilds (e.g. `carbon build`
            // after `carbon build`) every file is a hit and total Babel
            // time collapses to N file reads (~10–20 ms across the
            // tree).
            let phase1Code: string;
            if (phase1Plugins.length === 0) {
              // No phase-1 transforms needed (React native-JSX, no three-bridge,
              // no styles.css) — skip Babel's phase-1 entirely. src still has JSX
              // + TS, which Bun's loader transforms below.
              phase1Code = src;
            } else {
            const key1 = cache.enabled
              ? cacheKey(src, args.path, "phase1", phase1Sig)
              : "";
            const cached1 = cache.enabled ? tryReadCache(cache, key1) : null;
            if (cached1 !== null) {
              phase1Code = cached1;
            } else {
              try {
                const passA = transformSync(src, {
                  filename: args.path,
                  babelrc: false,
                  configFile: false,
                  browserslistConfigFile: false,
                  plugins: phase1Plugins,
                  parserOpts: {
                    plugins: ["jsx", "typescript"],
                    sourceType: "module",
                  },
                  generatorOpts: { compact: false },
                });
                phase1Code = passA?.code ?? src;
                if (cache.enabled) writeCacheEntry(cache, key1, phase1Code);
              } catch (e: any) {
                const loc = e?.loc ? `:${e.loc.line}:${e.loc.column}` : "";
                throw new Error(`Babel phase1 failed in ${args.path}${loc}: ${e?.message ?? e}`);
              }
            }
            }

            let phase2Code: string;
            const key2 = (cache.enabled && !useNativeJsx)
              ? cacheKey(phase1Code, args.path, "phase2", phase2Sig)
              : "";
            const cached2 = (cache.enabled && !useNativeJsx) ? tryReadCache(cache, key2) : null;
            if (useNativeJsx) {
              // React JSX + TS stripping is handled natively by Bun's tsx loader
              // (see `useNativeJsx`). Skip Babel's phase-2 entirely — phase1Code
              // still has JSX + TS, which the loader below transforms.
              phase2Code = phase1Code;
            } else if (cached2 !== null) {
              phase2Code = cached2;
            } else {
              try {
                // Framework branch:
                //   solid: babel-preset-solid in universal mode
                //          (compiles JSX → @carbon/mini-solid calls).
                //   react: @babel/preset-typescript + @babel/preset-react
                //          with automatic runtime + importSource set to
                //          @carbon/mini-react/jsx-runtime. The runtime
                //          re-exports React's own jsx/jsxs, so user code
                //          gets standard React semantics. Our adapter
                //          handles the host-config side via
                //          react-reconciler.
                const presets =
                  detectedFramework === "react"
                    ? [
                        [tsPreset, { allowDeclareFields: true, onlyRemoveTypeImports: true }],
                        [reactPreset, reactOpts],
                      ]
                    : [[solidPreset, solidOpts]];
                const r = transformSync(phase1Code, {
                  filename: args.path,
                  babelrc: false,
                  configFile: false,
                  browserslistConfigFile: false,
                  presets,
                  parserOpts: {
                    plugins: ["jsx", "typescript"],
                    sourceType: "module",
                  },
                  generatorOpts: { compact: false },
                });
                phase2Code = r?.code ?? phase1Code;
                if (cache.enabled) writeCacheEntry(cache, key2, phase2Code);
              } catch (e: any) {
                const loc = e?.loc ? `:${e.loc.line}:${e.loc.column}` : "";
                const presetName =
                  detectedFramework === "react" ? "react preset" : "solid preset";
                throw new Error(`Babel phase2 (${presetName}) failed in ${args.path}${loc}: ${e?.message ?? e}`);
              }
            }

            // Run Vite-shaped plugin `transform` hooks AFTER Babel — this
            // is where carbonDev splices its prelude into the entry chunk,
            // and where any future text-rewriting plugins land. The pass
            // is a no-op for files no plugin claims.
            const finalCode = runVitePluginTransforms(
              carbonPlugins,
              phase2Code,
              args.path,
            );

            babelMs += performance.now() - t1;
            filesTransformed++;
            // Hand whatever Babel + transform plugins produced back to Bun,
            // telling Bun to use its native loader for this extension.
            const ext =
              args.path.endsWith(".tsx") ? "tsx"
              : args.path.endsWith(".ctsx") ? "tsx"
              : args.path.endsWith(".ts") ? "ts"
              : args.path.endsWith(".jsx") ? "jsx"
              : "js";
            return { contents: finalCode, loader: ext };
          });
        },
      },
    ],
  });

  const totalMs = performance.now() - t0;

  if (!result.success) {
    const errors = result.logs.filter((m: any) => m.level === "error");
    const warnings = result.logs.filter((m: any) => m.level === "warning");

    // Log all messages, errors in red, warnings in yellow
    if (warnings.length > 0) {
      log.warn(`${warnings.length} warning(s)`);
      for (const w of warnings) {
        const line = w.position?.line ? `:${w.position.line}` : "";
        log.warn(`  ${w.name}${line}: ${w.message}`);
      }
    }

    if (errors.length > 0) {
      log.error(`${errors.length} error(s) during bundle`);
      for (const err of errors) {
        const line = err.position?.line ? `:${err.position.line}` : "";
        const col = err.position?.column ? `:${err.position.column}` : "";
        log.error(`  ${err.name}${line}${col}: ${err.message}`);
      }
    }

    throw new Error(
      `bun-build failed with ${errors.length} error(s)` +
      (warnings.length > 0 ? ` and ${warnings.length} warning(s)` : "")
    );
  }

  if (opts.debug || process.env.CARBON_BUILD_PROFILE) {
    const total = cache.stats.hits + cache.stats.misses;
    const hitRate = total > 0 ? ((cache.stats.hits / total) * 100).toFixed(0) : "n/a";
    log.step(
      `bun-build+babel: ${filesTransformed} file(s) transformed in ${babelMs.toFixed(0)} ms babel + ${(totalMs - babelMs).toFixed(0)} ms bun = ${totalMs.toFixed(0)} ms total` +
        (cache.enabled
          ? ` | babel-cache: ${cache.stats.hits} hit / ${cache.stats.misses} miss (${hitRate}%)`
          : ` | babel-cache: disabled`),
    );
  }

  // Prepend NPM-package polyfills to the bundle so they execute before
  // any module-init code (lodash, date-fns, etc. touch performance.now,
  // setTimeout, process at the top of their bundled output). Bun's
  // dependency-order topology can't guarantee polyfill placement, so we
  // inject directly after bundling.
  const bundlePath = join(projectDir, outFileRel);
  const POLYFILL_PRELUDE = CARBON_POLYFILL_PRELUDE;
  try {
    const existingBundle = readFileSync(bundlePath, "utf8");
    if (!existingBundle.startsWith("// carbon-mini polyfills")) {
      // ATOMIC write: write the prelude+bundle to a unique temp file, then
      // rename it over bundle.js. An in-place writeFileSync truncates then
      // streams the content, so carbon-mini's --dev watcher (or an
      // overlapping rebuild) could read a half-written / zero-padded file —
      // that's the NUL-byte corruption that broke the dev loop. rename() is
      // atomic on the same volume, so a reader always sees either the old
      // or the new complete file, never a partial one.
      //
      // IIFE-wrap the bundle body when building for HMR-with-bytecode (see
      // BunBabelBuildOptions.wrapIife). Re-eval of the compiled bytecode in
      // the same context would otherwise throw "redeclaration of <top-level
      // const>" and the hot-reload would silently fail (stale window). The
      // polyfill stays OUTSIDE the IIFE — it only assigns globals behind
      // typeof guards, so re-running it is a no-op. Production builds leave
      // wrapIife off so cold-start eval stays at top-level scope (~3× faster).
      const body = opts.wrapIife
        ? "(function(){\n" + existingBundle + "\n})();\n"
        : existingBundle;
      // Split app bundles (CJS, node_modules externalized) call require() for
      // each external — resolve those from the vendor registry the persistent
      // vendor.js populated. Defined on globalThis so it's visible inside the
      // IIFE-wrapped body.
      const REQUIRE_SHIM = opts.requireShim
        ? `// carbon-mini vendor require shim\n` +
          `if(typeof globalThis.require==='undefined'){globalThis.require=function(id){` +
          `var r=globalThis.__cm_vendor_reg;var m=r&&r[id];` +
          `if(m===undefined){throw new Error('[carbon-mini] vendor module not found: '+id)}` +
          `return m}}\n`
        : "";
      const tmp = `${bundlePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, POLYFILL_PRELUDE + REQUIRE_SHIM + body);
      renameSync(tmp, bundlePath);
    }
  } catch (e: any) {
    log.warn(`failed to prepend polyfills to bundle: ${e?.message ?? e}`);
  }

  return bundlePath;
}

// ─── Vendor/app split (experimental, opt-in via CARBON_SPLIT=1) ────────────
//
// Goal: sub-second HMR. node_modules never change during a dev session but the
// single-bundle path re-bundles + re-evals all ~4.6 MB on every save. The split
// compiles the heavy leaf packages ONCE into dist/vendor.js (eval'd once by the
// runtime, persists across HMR), and the app bundle contains only src/ + the
// React singleton, with the vendored packages externalized to require() calls
// resolved from the vendor registry. On HMR only the small app bundle rebuilds
// + re-evals.
//
// The React singleton + carbon's own integration packages stay IN the app
// bundle (they need carbon's react-dom → @carbon/mini-react resolution and must
// share one React instance with the reconciler).

const CARBON_POLYFILL_PRELUDE = `// carbon-mini polyfills (auto-injected)
(function(){var g=globalThis;
if(typeof g.performance==='undefined')g.performance={now:function(){return Date.now()}};
if(typeof g.global==='undefined')g.global=g;
if(typeof g.self==='undefined')g.self=g;
if(typeof g.navigator==='undefined')g.navigator={userAgent:'carbon-mini',platform:'carbon-mini',language:'en-US',languages:['en-US'],maxTouchPoints:0,hardwareConcurrency:4};
if(typeof g.process==='undefined')g.process={env:{NODE_ENV:'production'},nextTick:function(c){Promise.resolve().then(c).catch(function(){})},platform:'carbon-mini',version:'v0.1.0',versions:{node:'0.0.0'},hrtime:Object.assign(function(){var m=Date.now();return [Math.floor(m/1000),(m%1000)*1e6]},{bigint:function(){return BigInt(Date.now()*1e6)}})};
if(typeof g.queueMicrotask==='undefined')g.queueMicrotask=function(c){Promise.resolve().then(c).catch(function(){})};
if(typeof g.setTimeout==='undefined'){var _id=1,_t=new Map();var _tick=function(){var n=Date.now(),due=[];_t.forEach(function(t,id){if(n>=t.fireAt)due.push(id)});due.forEach(function(id){var t=_t.get(id);if(!t)return;try{t.cb()}catch(e){}if(t.interval!=null){t.fireAt=Date.now()+t.interval}else{_t.delete(id)}});if(_t.size>0&&typeof g.requestAnimationFrame==='function')g.requestAnimationFrame(_tick)};
g.setTimeout=function(c,m){var id=_id++,d=typeof m==='number'?m:0;_t.set(id,{fireAt:Date.now()+d,cb:c});if(_t.size===1&&typeof g.requestAnimationFrame==='function')g.requestAnimationFrame(_tick);return id};
g.clearTimeout=function(id){_t.delete(id)};
g.setInterval=function(c,m){var id=_id++,d=typeof m==='number'?m:0;_t.set(id,{fireAt:Date.now()+d,cb:c,interval:d});if(_t.size===1&&typeof g.requestAnimationFrame==='function')g.requestAnimationFrame(_tick);return id};
g.clearInterval=function(id){_t.delete(id)}}
if(typeof g.crypto==='undefined')g.crypto={getRandomValues:function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256);return a},randomUUID:function(){var h='0123456789abcdef',s='';for(var i=0;i<36;i++){if(i===8||i===13||i===18||i===23)s+='-';else if(i===14)s+='4';else if(i===19)s+=h[(Math.random()*4|0)+8];else s+=h[Math.random()*16|0]}return s}};
})();
`;

const SPLIT_KEEP_IN_APP = new Set([
  // react-dom is rewritten to @carbon/mini-react and the reconciler is bundled
  // in the APP (one copy). It + the app's components pull `react`, `scheduler`,
  // and `react/jsx-runtime` from the VENDOR registry, so there is a SINGLE
  // React instance shared by the app, the reconciler, and vendored packages
  // (radix, @ai-sdk/react, …). Hence react itself is vendored (NOT kept here).
  "react-dom", "react-dom/client", "react-reconciler", "@carbon/mini-react",
  "solid-js", "three",
  // ESM-only packages Bun can't expose through the CJS vendor require() —
  // keep them bundled in the app instead (Bun handles ESM there directly).
  "streamdown",
]);
// react family that MUST be vendored (single instance) — added to the vendor
// set even if a src scan misses them (Bun's automatic JSX injects the
// react/jsx-runtime import after our scan runs).
const SPLIT_FORCE_VENDOR = [
  "react", "react/jsx-runtime", "react/jsx-dev-runtime",
];
// scheduler is NOT force-vendored: it's a transitive dep of react-reconciler
// (which is bundled in the app via the react-dom rewrite), so it bundles into
// the app and isn't a singleton concern. Vendoring it failed Bun's CJS
// require() resolution anyway.
function splitKeepInApp(spec: string): boolean {
  if (SPLIT_KEEP_IN_APP.has(spec)) return true;
  if (spec.startsWith("carbon-") || spec.startsWith("@carbon/")) return true;
  return false;
}

/** Scan src/ for the exact bare specifiers the app imports (incl. subpaths and
 *  dynamic imports), minus the keep-in-app set. Those become the vendor set. */
function scanAppSpecifiers(projectDir: string): string[] {
  const found = new Set<string>();
  const reFrom = /\bfrom\s*["']([^"']+)["']/g;
  const reImp = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const reReq = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const abs = join(dir, name);
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (name === "node_modules" || name.startsWith(".")) continue; walk(abs); continue; }
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) continue;
      let src = ""; try { src = readFileSync(abs, "utf8"); } catch { continue; }
      for (const re of [reFrom, reImp, reReq]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          const spec = m[1];
          // Relative / absolute / carbon virtual modules — app code, not vendored.
          if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("carbon:")) continue;
          // tsconfig path alias "@/..." → maps to ./src, i.e. APP code. NOT a
          // package (an empty-scope "@/" is never a real npm specifier).
          if (spec.startsWith("@/")) continue;
          // Regex noise: a real package specifier has no whitespace and starts
          // like a package name (letter/@scope). Skips string literals that the
          // import/require regex accidentally matched.
          if (/\s/.test(spec)) continue;
          if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]/i.test(spec)) continue;
          if (splitKeepInApp(spec)) continue;
          found.add(spec);
        }
      }
    }
  };
  walk(join(projectDir, "src"));
  return Array.from(found).sort();
}

/** Build dist/vendor.js: every vendored specifier require()'d into a global
 *  registry. Bundles all of node_modules (transitively) once. */
export async function buildVendorBundle(projectDir: string, specifiers: string[]): Promise<string> {
  const dist = join(projectDir, "dist");
  mkdirSync(dist, { recursive: true });
  const lines = [
    // Install the web globals (document/window/TransformStream/URL/Streams/…)
    // BEFORE any vendored package initializes — the AI SDKs, xterm, etc. touch
    // them at module-init. In the single-bundle path this prelude runs in the
    // app entry; in the split, vendor evals first, so it must install here too.
    `require("@carbon/compat-dom/install");`,
    "globalThis.__cm_vendor_reg = globalThis.__cm_vendor_reg || {};",
  ];
  for (const s of specifiers) {
    lines.push(
      `try{globalThis.__cm_vendor_reg[${JSON.stringify(s)}]=require(${JSON.stringify(s)});}` +
      `catch(e){try{globalThis.console&&console.error("[vendor] failed "+${JSON.stringify(s)}+": "+(e&&e.message));}catch(_){}}`,
    );
  }
  const entryPath = join(dist, ".vendor-entry.cjs");
  writeFileSync(entryPath, lines.join("\n") + "\n");
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: dist,
    naming: { entry: "vendor.js" },
    target: "browser",
    format: "cjs",
    minify: !process.env.CARBON_DEBUG_BUILD,
    conditions: ["production"],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
    },
  });
  if (!result.success) {
    const errs = result.logs.filter((m: any) => m.level === "error").map((m: any) => m.message).join("; ");
    throw new Error(`vendor build failed: ${errs}`);
  }
  const vendorPath = join(dist, "vendor.js");
  try {
    const existing = readFileSync(vendorPath, "utf8");
    if (!existing.startsWith("// carbon-mini polyfills")) {
      const tmp = `${vendorPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, CARBON_POLYFILL_PRELUDE + existing);
      renameSync(tmp, vendorPath);
    }
  } catch { /* best-effort */ }
  return vendorPath;
}

/** Orchestrate a split build: vendor.js (built once / when deps change) + app
 *  bundle (externalized). The vendor skip is what makes HMR sub-second — a save
 *  rebuilds only the small app bundle. */
export async function buildBundleSplit(opts: BunBabelBuildOptions): Promise<void> {
  const vendorPath = join(opts.projectDir, "dist", "vendor.js");
  const specs = Array.from(
    new Set([...scanAppSpecifiers(opts.projectDir), ...SPLIT_FORCE_VENDOR]),
  ).sort();
  // Rebuild vendor only when missing or deps changed (package.json / lockfile
  // newer than vendor.js). HMR saves touch src/ only, so vendor is reused.
  let needVendor = !existsSync(vendorPath);
  if (!needVendor) {
    try {
      const vm = statSync(vendorPath).mtimeMs;
      for (const f of ["package.json", "bun.lock", "bun.lockb"]) {
        const p = join(opts.projectDir, f);
        if (existsSync(p) && statSync(p).mtimeMs > vm) { needVendor = true; break; }
      }
    } catch { needVendor = true; }
  }
  if (needVendor) {
    log.step(`carbon-split: ${specs.length} packages → dist/vendor.js (eval'd once)`);
    await buildVendorBundle(opts.projectDir, specs);
  } else {
    log.step(`carbon-split: vendor.js reused — app-only rebuild`);
  }
  await buildBundleWithBabel({ ...opts, external: specs, format: "cjs", requireShim: true });
}

/** True when split builds are requested (CARBON_SPLIT=1). */
export function splitEnabled(): boolean {
  return process.env.CARBON_SPLIT === "1";
}
