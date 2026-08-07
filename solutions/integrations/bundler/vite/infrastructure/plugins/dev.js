// @carbon/vite/dev — dev-only code injection.
//
// This plugin is a no-op in production builds. In dev (or when CARBON_DEV=1
// is set in the env) it injects three small pieces of glue into the entry
// chunk:
//
//   1. Error-overlay shim. Wraps the bundle's top-level execution in a
//      try/catch that posts a `__carbon_dev_error` message — a future
//      error-overlay plugin (or carbon-mini's own dev surface) can listen
//      for it and render a useful UI.
//
//   2. HMR helper. Subscribes to a small set of carbon-mini dev events
//      so signal-state updates trigger a soft reload without losing
//      persisted signals (createPersistentSignal already survives reload
//      because the rquickjs context isn't dropped, but the helper makes
//      the wiring explicit + extensible for future event types).
//
//   3. A `globalThis.__CARBON_DEV` flag + `__carbonDebug(...)` helper.
//      User code can write `if (__CARBON_DEV) console.log(...)` — and the
//      block disappears entirely in `carbon build` because the flag is
//      `false` everywhere outside dev.
//
// Mode detection
// --------------
// The plugin defers to Vite's resolved command:
//   - `vite serve` / dev = inject
//   - `vite build`        = inject only if CARBON_DEV=1 in the env
//   - production builds   = no-op (the plugin returns undefined for every
//                            transform, leaving Vite's plugin chain pristine)
//
// The mode-resolution logic mirrors @carbon/vite/transforms so the
// behavior is consistent across the plugin chain.

const ENTRY_FILE_RE = /\.(tsx|ts|jsx|js|mjs)$/;

// Marker we splice into the entry chunk so we never re-inject. The lookup is
// O(string length) but only runs once per file.
const INJECTED_MARKER = "/* @carbon-dev:injected */";

/**
 * @typedef {Object} CarbonDevOptions
 * @property {boolean} [errorOverlay]   Inject the error-overlay shim. Default: true.
 * @property {boolean} [hmr]            Inject the HMR helper. Default: true.
 * @property {boolean} [globals]        Inject `__CARBON_DEV` + `__carbonDebug`. Default: true.
 * @property {boolean} [debug]          Log per-file injections to stdout. Default: false.
 * @property {"dev" | "prod"} [forceMode] Override auto-detect of dev vs prod.
 */

/**
 * @param {CarbonDevOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function carbonDev(options = {}) {
  const {
    errorOverlay = true,
    hmr = true,
    globals = true,
    debug = false,
    forceMode,
  } = options;

  let active = false;
  let entryInjected = false;

  return {
    name: "@carbon/vite/dev",
    enforce: "post",

    configResolved(cfg) {
      const fromVite = cfg?.command === "serve";
      const fromEnv = process.env.CARBON_DEV === "1";
      if (forceMode === "dev") active = true;
      else if (forceMode === "prod") active = false;
      else active = fromVite || fromEnv;

      entryInjected = false;

      if (debug) {
        console.log(
          `[carbon-dev] mode=${active ? "DEV (injecting)" : "PROD (no-op)"}`,
        );
      }
    },

    transform(code, id) {
      if (!active) return null;
      if (typeof id !== "string") return null;
      if (id.includes("node_modules")) return null;
      // Virtual modules from other plugins (carbon-imports, ink-shim) start
      // with the rollup `\0` convention. Don't try to wrap them — they're
      // tiny re-exports.
      if (id.startsWith("\0")) return null;
      if (!ENTRY_FILE_RE.test(id)) return null;
      if (entryInjected) return null;
      if (code.includes(INJECTED_MARKER)) return null;

      // Heuristic: only inject into a file that looks like the bundle entry
      // (one that calls `mount(...)` or imports from @carbon/mini-solid).
      // Otherwise we'd splice the prelude into every transformed module,
      // which compounds and bloats the bundle.
      if (!isLikelyEntry(code)) return null;

      const prelude = buildPrelude({ errorOverlay, hmr, globals });
      if (!prelude) return null;

      entryInjected = true;
      if (debug) {
        console.log(`[carbon-dev] injected dev prelude into ${id}`);
      }
      return {
        code: `${INJECTED_MARKER}\n${prelude}\n${code}`,
        map: null,
      };
    },
  };
}

/** Detect whether a transformed file looks like the app entry. */
function isLikelyEntry(code) {
  // We look for any of the common carbon entry patterns:
  //   import { mount } from '@carbon/mini-solid'
  //   import { mount } from '@carbon/term'
  //   mount(() => …)
  // It's a heuristic, not a guarantee — a false positive injects the
  // prelude into a non-entry, which is harmless beyond the ~250 bytes.
  return (
    /from\s+["'](?:@carbon\/mini-solid|@carbon\/term)["']/.test(code) ||
    /\bmount\s*\(/.test(code)
  );
}

/** Compose the dev prelude based on which features are enabled. */
function buildPrelude({ errorOverlay, hmr, globals }) {
  const blocks = [];

  if (globals) {
    blocks.push(
      [
        `// @carbon/vite/dev: dev-mode globals`,
        `if (typeof globalThis !== "undefined") {`,
        `  globalThis.__CARBON_DEV = true;`,
        `  if (typeof globalThis.__carbonDebug !== "function") {`,
        `    globalThis.__carbonDebug = function () {`,
        `      try { console.log("[carbon:dev]", ...arguments); } catch {}`,
        `    };`,
        `  }`,
        `}`,
      ].join("\n"),
    );
  }

  if (errorOverlay) {
    // We can't wrap the *entire* module in try/catch from inside (the user's
    // code is appended below us) so we register top-level error listeners
    // instead. carbon-mini's QuickJS host surfaces unhandled errors through
    // a console.error path — listening for that gets us coverage of both
    // sync and Promise rejection paths.
    blocks.push(
      [
        `// @carbon/vite/dev: error-overlay shim`,
        `(function () {`,
        `  function postErr(err) {`,
        `    try {`,
        `      const payload = {`,
        `        kind: "__carbon_dev_error",`,
        `        message: (err && err.message) || String(err),`,
        `        stack: err && err.stack ? String(err.stack) : null,`,
        `      };`,
        `      if (typeof globalThis.__carbon_dev_post_error === "function") {`,
        `        globalThis.__carbon_dev_post_error(payload);`,
        `      } else if (typeof console !== "undefined" && console.error) {`,
        `        console.error("[carbon:dev] uncaught:", payload.message);`,
        `      }`,
        `    } catch (_) { /* never let the overlay itself throw */ }`,
        `  }`,
        `  if (typeof globalThis.addEventListener === "function") {`,
        `    try { globalThis.addEventListener("error", function (e) { postErr(e?.error ?? e); }); } catch {}`,
        `    try { globalThis.addEventListener("unhandledrejection", function (e) { postErr(e?.reason ?? e); }); } catch {}`,
        `  }`,
        `  globalThis.__carbon_dev_report = postErr;`,
        `})();`,
      ].join("\n"),
    );
  }

  if (hmr) {
    blocks.push(
      [
        `// @carbon/vite/dev: HMR helper`,
        `(function () {`,
        `  if (typeof globalThis.__carbon_hmr_register !== "function") {`,
        `    const handlers = new Set();`,
        `    globalThis.__carbon_hmr_register = function (fn) {`,
        `      if (typeof fn === "function") handlers.add(fn);`,
        `      return function dispose() { handlers.delete(fn); };`,
        `    };`,
        `    globalThis.__carbon_hmr_dispatch = function (evt) {`,
        `      for (const fn of handlers) {`,
        `        try { fn(evt); } catch (e) { /* swallow per-handler errors */ }`,
        `      }`,
        `    };`,
        `  }`,
        `})();`,
      ].join("\n"),
    );
  }

  if (blocks.length === 0) return "";
  return blocks.join("\n\n");
}

export default carbonDev;
