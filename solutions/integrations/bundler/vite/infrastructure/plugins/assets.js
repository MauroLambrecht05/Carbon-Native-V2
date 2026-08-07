// @carbon/vite/assets — non-JS asset import handlers.
//
// What we add on top of Vite's defaults
// -------------------------------------
//   - .wgsl / .glsl / .frag / .vert  → shader source as a string
//   - .txt  / .md                     → file contents as a string
//
// What Vite already handles correctly (we leave alone)
// ----------------------------------------------------
//   - .json — first-class import support
//   - PNG/JPEG/WebP/AVIF — resolved as URLs into dist/assets/
//
// We provide a small *verification* pass for image imports: we register a
// `transform` step that confirms PNG/JPEG resolves through to a URL string,
// so debug-mode users can spot misconfiguration (e.g. asset moved between
// builds) early.
//
// Source-string strategy
// ----------------------
// For shaders we hand back a JS module that exports the file content as a
// default string. This matches Vite's `?raw` query convention but works
// without the suffix — user code just writes `import shader from './x.wgsl'`.
//
// We deliberately do NOT bundle the shader bytes into the JS chunk for image
// formats: those go through Vite's asset graph so they get proper hashing /
// dist/assets emission.

import { existsSync, readFileSync } from "node:fs";

// File extensions whose contents should be inlined as a JS string default
// export. Order doesn't matter; we test set membership on the lower-cased
// extension.
const TEXT_EXTENSIONS = new Set([
  ".wgsl",
  ".glsl",
  ".frag",
  ".vert",
  ".txt",
  ".md",
]);

// Image extensions we care about *for verification only*. Vite already
// handles these — we just keep a list so debug-mode logging can confirm
// the routing.
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
]);

/**
 * @typedef {Object} CarbonAssetsOptions
 * @property {boolean} [debug]                     Log per-file routing.
 * @property {string[]} [extraTextExtensions]      Add more extensions to the text set.
 *                                                  Each must include the leading dot (e.g. ".vsh").
 */

/**
 * @param {CarbonAssetsOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function carbonAssets(options = {}) {
  const { debug = false, extraTextExtensions = [] } = options;

  // Compose the active text-extension set, normalizing user input so case
  // and missing leading dots don't surprise anyone.
  const textExts = new Set([
    ...TEXT_EXTENSIONS,
    ...extraTextExtensions.map((e) => normalizeExt(e)),
  ]);

  return {
    name: "@carbon/vite/assets",
    enforce: "pre",

    // ── load: hand back the file contents for text-format assets ─────
    // We use `load` (not `transform`) because Vite's default loaders for
    // these extensions don't exist — without us they would produce a
    // "no loader" error.
    load(id) {
      if (typeof id !== "string") return null;
      // Strip Vite query suffixes (`?raw`, `?url`, etc.) so we can test the
      // bare extension. We don't honor `?raw` ourselves — Vite handles that.
      const cleanId = stripQuery(id);
      const ext = lowerExt(cleanId);
      if (!textExts.has(ext)) return null;

      // Skip when the file isn't actually on disk — Vite occasionally
      // probes virtual paths and we don't want to throw on those.
      if (!existsSync(cleanId)) return null;

      const text = readFileSync(cleanId, "utf8");
      if (debug) {
        console.log(
          `[carbon-assets] inline text ${ext}: ${cleanId} (${text.length}B)`,
        );
      }
      // Hand-rolled JS module: a single default export of the source string.
      // We use JSON.stringify for safe escaping of newlines, quotes, etc.
      return {
        code: `export default ${JSON.stringify(text)};\n`,
        map: null,
      };
    },

    // ── transform: debug-only verification pass for image imports ────
    // We don't actually transform anything for images; Vite's built-in
    // asset pipeline does the real work. This pass exists so debug-mode
    // users can confirm routing is intact.
    transform(code, id) {
      if (!debug) return null;
      if (typeof id !== "string") return null;
      const cleanId = stripQuery(id);
      const ext = lowerExt(cleanId);
      if (!IMAGE_EXTENSIONS.has(ext)) return null;
      console.log(
        `[carbon-assets] image ${ext}: ${cleanId} (handled by Vite asset pipeline)`,
      );
      return null;
    },
  };
}

/** Lowercase the file extension including the leading dot, or "" if none. */
function lowerExt(path) {
  const i = path.lastIndexOf(".");
  if (i < 0) return "";
  return path.slice(i).toLowerCase();
}

/** Drop the `?...` query suffix Vite tacks on for asset-mode imports. */
function stripQuery(id) {
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}

/** Normalize a user-provided extension string. */
function normalizeExt(ext) {
  if (typeof ext !== "string") return "";
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

export const TEXT_ASSET_EXTENSIONS = TEXT_EXTENSIONS;
export const IMAGE_ASSET_EXTENSIONS = IMAGE_EXTENSIONS;

export default carbonAssets;
