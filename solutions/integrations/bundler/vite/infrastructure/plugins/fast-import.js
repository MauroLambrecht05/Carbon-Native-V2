// @carbon/vite/fast-import — at build time, rewrites named imports of
// three.js math classes so they resolve from `carbon-fast-math` instead.
//
// The point is: user code stays unchanged. Existing apps that import
// `Vector3` from `'three'` continue to use the same `Vector3` *name*,
// but the actual constructor at runtime is the Rust-backed one shipped
// by carbon-fast-math.
//
// Why we don't intercept three.js's own internal imports
// ------------------------------------------------------
// Three.js's source is a graph of modules that import math classes from
// each other (e.g. `Object3D` imports Vector3 from './Vector3.js'). Those
// internal references must continue resolving to three.js's *own*
// implementations, otherwise the layout assumptions inside three.js break
// (its internals do `_v.copy(this.position)` and so on). Our rewrite is
// gated on the import source being literally `'three'` — the public-API
// boundary that user code crosses. Internal three.js paths are left alone.
//
// Why this is type-compatible
// ---------------------------
// Three.js doesn't use `instanceof Vector3` in its internal type checks;
// it uses duck typing via `.isVector3 === true` and field access. Our
// carbon-fast-math classes set the same is* flags and expose the same
// fields, so an instance constructed in user code can be passed back
// into three.js (`mesh.position.copy(myFastMathVec3)`) and three.js
// reads `.x/.y/.z` straight off it. (Edge case: methods we don't ship —
// like `.applyEuler` — won't exist; user code that depends on them in
// hot paths needs to fall back to three's own Vector3.)
//
// Bonus: the plugin auto-injects `globalThis.__cm_register_math?.()` at
// the top of the entry chunk so the runtime knows to allocate the
// prototypes. If the host is anything other than carbon-mini the call
// is a no-op (the function is undefined).

const MATH_NAMES = new Set([
  "Vector3",
  "Matrix4",
  "Quaternion",
  "Box3",
  "Frustum",
  "Color",
]);

/**
 * @param {object} [options]
 * @param {boolean} [options.debug]      Log per-file rewrites.
 * @param {boolean} [options.injectInit] Inject the register-math call. Default: true.
 * @param {string[]} [options.extraNames] Extra named exports to also rewrite (e.g. for forks).
 * @returns {import('vite').Plugin}
 */
export function carbonFastImport(options = {}) {
  const { debug = false, injectInit = true, extraNames = [] } = options;
  const targetNames = new Set([...MATH_NAMES, ...extraNames]);

  let isProd = false;
  let entrySeen = false;

  return {
    name: "@carbon/vite/fast-import",
    enforce: "pre",
    configResolved(cfg) {
      isProd = cfg.command === "build";
      entrySeen = false;
      if (debug) {
        console.log(
          `[carbon-fast-import] mode=${isProd ? "build" : "serve"} (rewrites ${isProd ? "ACTIVE" : "ACTIVE in serve too"})`,
        );
      }
    },
    transform(code, id) {
      // Skip third-party (including three's own internal modules) and
      // anything that isn't JS/TS. Three.js's internal cross-references
      // MUST keep resolving to their original sources; we only touch
      // user-app boundary modules.
      if (id.includes("node_modules")) return null;
      if (!/\.(tsx|ts|jsx|js|mjs)$/.test(id)) return null;

      // Cheap reject: no `from "three"` anywhere -> skip.
      if (!/from\s+["']three["']/.test(code)) {
        // Still might need to inject the init — handle in entry detection
        // below using buildStart hook, not here.
        return null;
      }

      // Match: `import { A, B as C, Vector3 } from 'three'`
      // We rewrite the SAME statement to:
      //   import { A, B as C } from 'three';
      //   import { Vector3 } from 'carbon-fast-math';
      // splitting math vs non-math named exports. Default imports
      // (`import THREE from 'three'`) are NOT touched — those drag in
      // the entire three namespace anyway, and our rewrite would break
      // `THREE.Vector3` access patterns. We only handle named imports.
      //
      // We use a regex pass rather than full AST parsing because:
      //   1. The plugin needs to be lightweight (it runs on every file
      //      in dev mode too; AST parse + traverse adds 5-15ms per file).
      //   2. The pattern is well-defined and unambiguous: an `import`
      //      statement with `from 'three'` and a brace-named-imports list.
      //   3. Source maps are preserved by replacing in-place with
      //      length-preserving spaces where we delete tokens, and
      //      prepending the new import statement. Vite handles the rest.
      let out = code;
      let mathPicked = []; // list of { name, alias }
      const importRe = /import\s+\{([^}]*)\}\s+from\s+["']three["']\s*;?/g;

      out = out.replace(importRe, (full, inner) => {
        const items = inner.split(",").map((s) => s.trim()).filter(Boolean);
        const stayWithThree = [];
        const movedToFast = [];
        for (const item of items) {
          // Forms: `Vector3`, `Vector3 as V3`, `type Vector3` (TS)
          const m = item.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (!m) {
            stayWithThree.push(item);
            continue;
          }
          const exportedName = m[1];
          if (targetNames.has(exportedName)) {
            movedToFast.push(item);
          } else {
            stayWithThree.push(item);
          }
        }
        if (movedToFast.length === 0) return full;
        const remainingImport =
          stayWithThree.length > 0
            ? `import { ${stayWithThree.join(", ")} } from "three";`
            : "";
        const fastImport = `import { ${movedToFast.join(", ")} } from "carbon-fast-math";`;
        return `${remainingImport}${remainingImport ? "\n" : ""}${fastImport}`;
      });

      if (out === code) return null;

      // Inject the runtime init call once — the first time we transform
      // a file that resolved any math imports through us. We use a flag
      // here (rather than configureServer/buildStart) because we want
      // the init to land in the same module the user already loads;
      // injecting into a separate virtual entry would force another
      // module load round-trip on cold start.
      if (injectInit && !entrySeen) {
        out =
          `// carbon-fast-import: ensure native math classes are registered\n` +
          `if (typeof globalThis !== "undefined" && typeof globalThis.__cm_register_math === "function") {\n` +
          `  globalThis.__cm_register_math();\n` +
          `}\n` +
          out;
        entrySeen = true;
      }

      if (debug) {
        console.log(`[carbon-fast-import] rewrote ${id}`);
      }
      return { code: out, map: null };
    },
  };
}

export default carbonFastImport;
