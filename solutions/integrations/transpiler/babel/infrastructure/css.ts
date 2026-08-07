// carbon-css-babel — Babel plugin that compiles `class="foo"` JSX attrs
// into inline `style={{...}}` based on a project-local `styles.css`.
//
// Why we do this at build time, not runtime:
//   - The carbon-mini scene paint reads `style` props directly. There's
//     no CSS engine in the runtime — adding one is heavyweight.
//   - At build time we already touch every JSX file via Babel, and the
//     CSS file is read once per build. The output is plain inline styles
//     identical to what a user would write by hand.
//
// What's supported:
//   - Flat `.selector { prop: value; }` rules
//   - Multiple selectors per rule: `.a, .b { ... }`
//   - `/* ... */` comments
//   - Numeric values with `px` suffix → number; everything else → string
//   - The carbon-mini PaintProps prop set:
//       background, color, padding, padding-x, padding-y, gap, width,
//       height, font-size, border-radius, flex-direction, justify-content,
//       align-items
//
// What's NOT supported (silently dropped, won't error):
//   - Pseudo-classes (:hover, :active, …)
//   - Nested selectors
//   - @media / @keyframes / @font-face
//   - Combinators (.foo .bar, .foo > .bar)
//   - Properties the runtime doesn't recognize (margin, border-color, etc.)
//
// Usage in build-pipeline.ts:
//   const plugin = makeCarbonCssBabel(projectDir);
//   if (plugin) phase1Plugins.push(plugin);

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type StyleProps = Record<string, string | number>;

/**
 * Parse a tiny subset of CSS into a `class -> styleProps` map.
 *
 * Strips comments first, then walks `selector { decls }` blocks. Selectors
 * starting with `.` become class names; anything else is ignored. Each
 * declaration `prop: value;` is parsed into the style props map after
 * normalizing property names + numeric values for the carbon-mini runtime.
 */
export function parseCssToClassMap(css: string): Record<string, StyleProps> {
  const out: Record<string, StyleProps> = {};
  // Strip /* ... */ comments — non-greedy, multiline.
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // Walk top-level rule blocks. The regex captures the selector list and
  // the declaration body (between `{` and `}`).
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cleaned)) !== null) {
    const selectorList = m[1].trim();
    const body = m[2].trim();
    if (!selectorList || !body) continue;

    // Parse the declaration body once (same styles for every selector).
    const props: StyleProps = {};
    for (const decl of body.split(";")) {
      const trimmed = decl.trim();
      if (!trimmed) continue;
      const colonAt = trimmed.indexOf(":");
      if (colonAt < 0) continue;
      const key = trimmed.slice(0, colonAt).trim();
      const valueRaw = trimmed.slice(colonAt + 1).trim();
      if (!key || !valueRaw) continue;

      const normalized = normalizeProp(key, valueRaw);
      if (normalized) {
        props[normalized.key] = normalized.value;
      }
    }
    if (Object.keys(props).length === 0) continue;

    // Apply the parsed props to every class selector in the list.
    // `.foo` → base props.
    // `.foo:hover` → each prop is suffixed with `-hover` and merged
    //   onto the base class. The runtime swaps these in when the cursor
    //   is over a clickable node.
    for (const sel of selectorList.split(",")) {
      const trimmed = sel.trim();
      if (!trimmed.startsWith(".") || trimmed.length < 2) continue;

      // Detect a single `:hover` pseudo-class on the class selector.
      const hoverMatch = /^\.([A-Za-z0-9_-]+):hover$/.exec(trimmed);
      if (hoverMatch) {
        const className = hoverMatch[1];
        const hoverProps: StyleProps = {};
        for (const [k, v] of Object.entries(props)) {
          hoverProps[`${k}-hover`] = v;
        }
        out[className] = { ...(out[className] ?? {}), ...hoverProps };
        continue;
      }

      // Plain class selector — no whitespace / combinators / pseudos.
      if (!/[\s>+~:]/.test(trimmed.slice(1))) {
        const className = trimmed.slice(1);
        out[className] = { ...(out[className] ?? {}), ...props };
      }
    }
  }
  return out;
}

/**
 * Normalize a CSS declaration into a (key, value) pair the runtime accepts.
 * Returns null if the property isn't supported (caller drops it).
 */
function normalizeProp(rawKey: string, rawValue: string): { key: string; value: string | number } | null {
  // Map CSS property names → carbon-mini PaintProps names. The runtime's
  // scene.rs already accepts kebab-case for compound names (font-size,
  // border-radius, etc.), so we mostly pass through with a few rewrites
  // for properties whose CSS name doesn't match the runtime's name.
  const rewrites: Record<string, string> = {
    "background-color": "background",
    "padding-left": "padding-x",
    "padding-right": "padding-x",
    "padding-top": "padding-y",
    "padding-bottom": "padding-y",
  };
  const key = rewrites[rawKey] ?? rawKey;

  // Whitelist the keys the runtime actually paints. Everything else is a
  // no-op — silently drop so authors don't get surprises like CSS-engine
  // semantics that the runtime can't honor.
  const SUPPORTED = new Set([
    "background",
    "color",
    "font-size",
    "border-radius",
    "flex-direction",
    "flex-wrap",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "justify-content",
    "align-items",
    "padding",
    "padding-x",
    "padding-y",
    "gap",
    "width",
    "height",
    "min-width",
    "max-width",
    "min-height",
    "max-height",
    "overflow",
    "overflow-y",
    "background-image",
    "background-size",
  ]);
  if (!SUPPORTED.has(key)) return null;

  // Sizing keys keep percent units as strings (the runtime parses them);
  // everything else strips trailing px and parses as number where it can.
  const value = parseValue(rawValue);
  return { key, value };
}

function parseValue(raw: string): string | number {
  const v = raw.trim();
  // Percent values stay as strings — the runtime's parse_len reads
  // "100%" -> Percent(1.0).
  if (/^-?\d+(?:\.\d+)?%$/.test(v)) return v;
  // Drop trailing `px` and parse — covers the common `10px` form.
  const pxMatch = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (pxMatch) return Number(pxMatch[1]);
  // Plain numbers (no unit) — parse as number.
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  // Strip surrounding quotes if any — `"row"` and `row` are equivalent here.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Build the Babel plugin function. Returns null if no `styles.css` exists
 * in `projectDir` — in that case the plugin is just skipped.
 */
export function makeCarbonCssBabel(
  projectDir: string,
): null | ((api: { types: any }) => any) {
  const cssPath = join(projectDir, "styles.css");
  if (!existsSync(cssPath)) return null;

  let cssText: string;
  try {
    cssText = readFileSync(cssPath, "utf8");
  } catch {
    return null;
  }
  const classMap = parseCssToClassMap(cssText);
  if (Object.keys(classMap).length === 0) return null;

  // The plugin builder closes over `classMap` so each Babel pass uses the
  // same parsed table — no re-reading the CSS per file.
  return function carbonCssBabel({ types: t }: { types: any }) {
    function buildStyleObjectAst(props: StyleProps): any {
      return t.objectExpression(
        Object.entries(props).map(([key, value]) => {
          // Quote keys that contain hyphens (CSS-shape) — Babel's parser
          // rejects unquoted hyphens in object literals.
          const keyNode = /^[a-zA-Z_$][\w$]*$/.test(key)
            ? t.identifier(key)
            : t.stringLiteral(key);
          const valueNode =
            typeof value === "number"
              ? t.numericLiteral(value)
              : t.stringLiteral(value);
          return t.objectProperty(keyNode, valueNode);
        }),
      );
    }

    return {
      name: "carbon-css",
      visitor: {
        JSXAttribute(path: any) {
          const nameNode = path.node.name;
          if (!t.isJSXIdentifier(nameNode)) return;
          const attrName = nameNode.name;
          if (attrName !== "class" && attrName !== "className") return;

          // Only static string class lists — dynamic ones (`class={x}`)
          // can't be resolved at build time.
          let raw: string | null = null;
          if (t.isStringLiteral(path.node.value)) {
            raw = path.node.value.value;
          } else if (
            t.isJSXExpressionContainer(path.node.value) &&
            t.isStringLiteral(path.node.value.expression)
          ) {
            raw = path.node.value.expression.value;
          }
          if (raw == null) return;

          const resolved: StyleProps = {};
          const unresolved: string[] = [];
          for (const cls of raw.split(/\s+/).filter(Boolean)) {
            const props = classMap[cls];
            if (props) Object.assign(resolved, props);
            else unresolved.push(cls);
          }
          if (Object.keys(resolved).length === 0) return;

          // Merge into existing style={{...}} or add a new one. Same merge
          // strategy as the Tailwind plugin (CSS rules first, inline
          // overrides win).
          const styleObjAst = buildStyleObjectAst(resolved);
          const opening = path.parentPath.node;
          if (!t.isJSXOpeningElement(opening)) return;

          const existing = opening.attributes.find(
            (a: any) =>
              t.isJSXAttribute(a) &&
              t.isJSXIdentifier(a.name) &&
              a.name.name === "style",
          );

          if (existing && t.isJSXExpressionContainer(existing.value)) {
            const inlineExpr = existing.value.expression;
            if (t.isObjectExpression(inlineExpr)) {
              existing.value = t.jsxExpressionContainer(
                t.objectExpression([
                  ...styleObjAst.properties,
                  ...inlineExpr.properties,
                ]),
              );
            } else if (t.isExpression(inlineExpr)) {
              existing.value = t.jsxExpressionContainer(
                t.objectExpression([
                  t.spreadElement(styleObjAst),
                  t.spreadElement(inlineExpr),
                ]),
              );
            }
          } else {
            opening.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier("style"),
                t.jsxExpressionContainer(styleObjAst),
              ),
            );
          }

          // If every class resolved, drop the class attr; otherwise keep
          // the unresolved ones (Tailwind plugin may pick them up later).
          if (unresolved.length > 0) {
            path.node.value = t.stringLiteral(unresolved.join(" "));
          } else {
            path.remove();
          }
        },
      },
    };
  };
}
