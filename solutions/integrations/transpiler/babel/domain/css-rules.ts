// Parsing the project's `styles.css` into a `class -> styleProps` map.
//
// The half of the carbon-css compiler that is not a Babel plugin: it takes a
// string of CSS and answers with plain objects. No Babel, no filesystem, no
// JSX — so the rules can be exercised against a literal, which is what the
// tests do.
//
// What's supported:
//   - Flat `.selector { prop: value; }` rules
//   - Multiple selectors per rule: `.a, .b { ... }`
//   - `/* ... */` comments
//   - Numeric values with `px` suffix -> number; everything else -> string
//   - The carbon-mini PaintProps prop set:
//       background, color, padding, padding-x, padding-y, gap, width,
//       height, font-size, border-radius, flex-direction, justify-content,
//       align-items
//
// Not supported (and silently dropped):
//   - Nested rules, media queries, pseudo-selectors
//   - Element/id selectors (`div { }`, `#app { }`)
//   - Properties the runtime doesn't recognize (margin, border-color, etc.)

export type StyleProps = Record<string, string | number>;

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
