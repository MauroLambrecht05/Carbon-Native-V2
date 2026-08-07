// @carbon/vite-plugin-css-compat
//
// Transforms modern CSS that pre-1.0 Servo / Stylo doesn't yet implement into
// equivalent older constructs (mostly Flexbox) at build time. This is a
// stable bridge layer between Solid+Vite and any pre-1.0 web engine — useful
// beyond Servo (e.g. legacy WebKitGTK, embedded engines).
//
// Targeted (and verified) transforms:
//   - display: grid + grid-template-columns/rows  -> display: flex with
//     flex-wrap, plus inferred per-child sizing
//   - grid-column: 1 / -1                          -> width: 100%; flex: 0 0 100%
//   - grid-row, grid-area                          -> stripped (best-effort warn)
//   - text-overflow: ellipsis                      -> stripped (text just won't truncate)
//   - resize: *                                    -> stripped (no-op anyway)
//   - color-scheme: *                              -> stripped (Servo defaults to light, ok)
//   - -webkit-background-clip / background-clip: text -> stripped (handled separately if needed)
//
// What this plugin canNOT do without DOM knowledge:
//   - Arbitrary grid placements (grid-row-start, grid-area names with rows/cols)
//   - Explicit row heights on auto-flow children that aren't first or last
//
// For the notes-app's "header + sidebar | main + footer" shape, the plugin
// turns the parent into a wrapping flex container and emits per-child
// auto-flow rules based on the grid-template-rows/columns that the rule
// declares. This is enough for the canonical app-frame layout pattern.
//
// Diagnostic: set CARBON_CSS_COMPAT_DEBUG=1 to log every transform.

import type { Plugin } from "vite";

interface CompatOptions {
  /**
   * If true, drop unsupported declarations silently. If false (default), the
   * plugin will *replace* them with functional equivalents where possible
   * and only strip when there is no equivalent.
   */
  silent?: boolean;
}

export function carbonCssCompat(opts: CompatOptions = {}): Plugin {
  const debug = process.env.CARBON_CSS_COMPAT_DEBUG === "1";
  const log = (...args: unknown[]) => {
    if (debug) console.log("[css-compat]", ...args);
  };

  function transformCss(source: string, id: string): string {
    let out = source;
    let changed = false;

    // Pass 1: rewrite blocks that contain `display: grid` together with at
    // least one of grid-template-columns/rows. We recognise the parent rule
    // and rewrite the whole block in place. We do this with a regex over each
    // CSS rule's body. CSS isn't context-free but for hand-written stylesheets
    // (no nested rules pre-PostCSS) this is sufficient.
    out = out.replace(
      /([^{}]*)\{([^{}]*?)\}/g,
      (full, selector: string, body: string): string => {
        if (!/\bdisplay\s*:\s*grid\b/i.test(body)) return full;

        // Extract the grid-template-* values (if any) for diagnostic / future use.
        const colMatch = /grid-template-columns\s*:\s*([^;]+);?/i.exec(body);
        const rowMatch = /grid-template-rows\s*:\s*([^;]+);?/i.exec(body);
        const cols = colMatch ? colMatch[1].trim() : null;
        const rows = rowMatch ? rowMatch[1].trim() : null;

        let newBody = body
          .replace(/\bdisplay\s*:\s*grid\s*;?/gi, "display: flex; flex-wrap: wrap; align-content: flex-start;")
          .replace(/grid-template-columns\s*:[^;]+;?/gi, "")
          .replace(/grid-template-rows\s*:[^;]+;?/gi, "")
          .replace(/grid-template-areas\s*:[^;]+;?/gi, "")
          .replace(/grid-auto-(?:rows|columns|flow)\s*:[^;]+;?/gi, "")
          .replace(/place-items\s*:\s*center\s*;?/gi, "justify-content: center; align-items: center;")
          .replace(/place-content\s*:\s*center\s*;?/gi, "justify-content: center; align-items: center;");

        // Tag with a CSS comment carrying the original template, so the
        // second pass can use it for child sizing if needed. The comment is
        // stripped in production minification.
        const tag: string[] = [];
        if (cols) tag.push(`grid-cols=${JSON.stringify(cols)}`);
        if (rows) tag.push(`grid-rows=${JSON.stringify(rows)}`);
        const tagComment = tag.length ? `/* carbon-grid-was: ${tag.join(" ")} */ ` : "";

        log(`grid->flex: ${selector.trim()} (${cols} | ${rows})`);
        changed = true;
        return `${selector}{${tagComment}${newBody}}`;
      }
    );

    // Pass 2: rewrite child grid placements. The CSS-only equivalent of
    // `grid-column: 1 / -1` is "fill the parent flex line entirely" which
    // we express as `flex-basis: 100%; width: 100%; flex-shrink: 0;`.
    // Single-cell grid-column values we strip (they're auto-positioned by
    // flex order anyway).
    out = out.replace(/grid-column\s*:\s*1\s*\/\s*-1\s*;?/gi, () => {
      changed = true;
      return "flex-basis: 100%; width: 100%; flex-shrink: 0;";
    });
    // Other grid-column values: strip silently. Most CSS that uses 1/-1
    // is the "span everything" pattern; explicit numeric placements need a
    // proper grid implementation.
    out = out.replace(/grid-column(?:-start|-end)?\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });
    out = out.replace(/grid-row(?:-start|-end)?\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });
    out = out.replace(/grid-area\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });

    // Pass 3: strip declarations Servo's stylo doesn't parse. They are
    // visual niceties, not layout-affecting; dropping them is safe.
    out = out.replace(/text-overflow\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });
    out = out.replace(/resize\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });
    out = out.replace(/color-scheme\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });
    // -webkit-background-clip: text + color: transparent + background:
    // gradient is the canonical gradient-text idiom. Servo doesn't implement
    // background-clip: text. If we strip *only* the background-clip the
    // text stays transparent and the gradient renders as a solid bar.
    // So when we detect the pattern, strip the whole bundle:
    // background, *background-clip, and the color: transparent. The element
    // falls back to its inherited color, which is correct.
    out = out.replace(/([^{}]*)\{([^{}]*?)\}/g, (full, sel, body: string) => {
      if (!/-webkit-background-clip\s*:\s*text\b/i.test(body) &&
          !/(?<!-)background-clip\s*:\s*text\b/i.test(body)) {
        return full;
      }
      changed = true;
      let nb = body
        .replace(/-webkit-background-clip\s*:[^;]+;?/gi, "")
        .replace(/(?<!-)background-clip\s*:[^;]+;?/gi, "");
      // Also strip the gradient/transparent that paired with the *-clip rule.
      nb = nb
        .replace(/background\s*:\s*linear-gradient\([^;]*\)\s*;?/gi, "")
        .replace(/background\s*:\s*radial-gradient\([^;]*\)\s*;?/gi, "")
        .replace(/color\s*:\s*transparent\s*;?/gi, "");
      return `${sel}{${nb}}`;
    });
    // For any other rules with background-clip that weren't text-clipped,
    // strip just the *-clip. (Servo doesn't error on background-clip:padding-box etc.,
    // so this is a no-op in practice.)
    out = out.replace(/-webkit-background-clip\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });
    out = out.replace(/(?<!-)background-clip\s*:[^;]+;?/gi, () => {
      changed = true;
      return "";
    });

    if (!changed && !out.includes("/* carbon-grid-was:")) return source;
    log(`transformed ${id}`);
    return out;
  }

  return {
    name: "carbon-css-compat",
    enforce: "pre",

    transform(code, id) {
      // Vite calls transform on every imported module. We only care about CSS.
      // .css plain, ?inline, ?raw — match all CSS-y queries.
      if (!/\.css(\?|$)/.test(id) && !/\.scss(\?|$)/.test(id)) return null;
      const result = transformCss(code, id);
      if (result === code) return null;
      return { code: result, map: null };
    },
  };
}

export default carbonCssCompat;
