// Curated Tailwind utility subset → carbon-mini CarbonStyle property bag.
// What's mapped is what carbon-mini's paint pipeline understands today; new
// utilities ship as the runtime grows the prop schema.
//
// Conventions match Tailwind defaults (4px = 1 unit). Colors come from the
// Tailwind v3 default palette (`gray`, `slate`, `red`, `orange`, `amber`,
// `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`,
// `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose` × 50…900).

export type StyleProps = Record<string, string | number>;

const COLORS: Record<string, Record<string, string>> = {
  white: { DEFAULT: "#ffffff" },
  black: { DEFAULT: "#000000" },
  gray: {
    "50": "#f9fafb", "100": "#f3f4f6", "200": "#e5e7eb", "300": "#d1d5db",
    "400": "#9ca3af", "500": "#6b7280", "600": "#4b5563", "700": "#374151",
    "800": "#1f2937", "900": "#111827", "950": "#030712",
  },
  slate: {
    "50": "#f8fafc", "100": "#f1f5f9", "200": "#e2e8f0", "300": "#cbd5e1",
    "400": "#94a3b8", "500": "#64748b", "600": "#475569", "700": "#334155",
    "800": "#1e293b", "900": "#0f172a",
  },
  red: {
    "100": "#fee2e2", "200": "#fecaca", "300": "#fca5a5", "400": "#f87171",
    "500": "#ef4444", "600": "#dc2626", "700": "#b91c1c",
  },
  orange: {
    "400": "#fb923c", "500": "#f97316", "600": "#ea580c",
  },
  amber: {
    "400": "#fbbf24", "500": "#f59e0b", "600": "#d97706",
  },
  yellow: {
    "400": "#facc15", "500": "#eab308",
  },
  green: {
    "400": "#4ade80", "500": "#22c55e", "600": "#16a34a", "700": "#15803d",
  },
  emerald: {
    "500": "#10b981", "600": "#059669",
  },
  teal: {
    "500": "#14b8a6", "600": "#0d9488",
  },
  cyan: {
    "400": "#22d3ee", "500": "#06b6d4",
  },
  sky: {
    "400": "#38bdf8", "500": "#0ea5e9",
  },
  blue: {
    "100": "#dbeafe", "200": "#bfdbfe", "300": "#93c5fd", "400": "#60a5fa",
    "500": "#3b82f6", "600": "#2563eb", "700": "#1d4ed8", "800": "#1e40af",
  },
  indigo: {
    "400": "#818cf8", "500": "#6366f1", "600": "#4f46e5",
  },
  violet: {
    "400": "#a78bfa", "500": "#8b5cf6", "600": "#7c3aed",
  },
  purple: {
    "400": "#c084fc", "500": "#a855f7", "600": "#9333ea",
  },
  fuchsia: {
    "500": "#d946ef",
  },
  pink: {
    "400": "#f472b6", "500": "#ec4899",
  },
  rose: {
    "500": "#f43f5e",
  },
};

const SPACING_SCALE: Record<string, number> = {
  "0": 0, px: 1, "0.5": 2, "1": 4, "1.5": 6, "2": 8, "2.5": 10, "3": 12,
  "3.5": 14, "4": 16, "5": 20, "6": 24, "7": 28, "8": 32, "9": 36, "10": 40,
  "11": 44, "12": 48, "14": 56, "16": 64, "20": 80, "24": 96, "28": 112,
  "32": 128, "36": 144, "40": 160, "44": 176, "48": 192, "52": 208, "56": 224,
  "60": 240, "64": 256, "72": 288, "80": 320, "96": 384,
};

const FONT_SIZE: Record<string, number> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36,
  "5xl": 48, "6xl": 60, "7xl": 72, "8xl": 96, "9xl": 128,
};

const FONT_WEIGHT: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500,
  semibold: 600, bold: 700, extrabold: 800, black: 900,
};

const RADIUS: Record<string, number> = {
  none: 0, sm: 2, DEFAULT: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24,
  full: 9999,
};

// shadcn / radix-luma design tokens — dark variant matching terax-ai's
// default theme (the app's index.html resolves dark on first paint).
// These are the named tokens shadcn-style components use via classes
// like `bg-background`, `text-muted-foreground`, `border-border`.
// Apps using a different theme would map to a different palette;
// for the carbon-mini paint pipeline we resolve at build time so a
// runtime theme swap isn't supported in v1.
// shadcn-flavoured semantic token table. Apps provide their own
// theme via `@theme` / `:root` CSS variable blocks; the build
// pipeline parses those and calls `setThemeTokens(...)` before the
// JSX babel pass runs. The DEFAULT here is shadcn's stock LIGHT
// palette so plain-tailwind apps without a theme block still render
// recognisably.
let SHADCN_TOKENS: Record<string, string> = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  card: "#ffffff",
  "card-foreground": "#0a0a0a",
  popover: "#ffffff",
  "popover-foreground": "#0a0a0a",
  primary: "#171717",
  "primary-foreground": "#fafafa",
  secondary: "#f5f5f5",
  "secondary-foreground": "#171717",
  muted: "#f5f5f5",
  "muted-foreground": "#737373",
  accent: "#f5f5f5",
  "accent-foreground": "#171717",
  destructive: "#ef4444",
  "destructive-foreground": "#fafafa",
  border: "#e5e5e5",
  input: "#e5e5e5",
  ring: "#a3a3a3",
  sidebar: "#fafafa",
  "sidebar-foreground": "#0a0a0a",
  "sidebar-primary": "#171717",
  "sidebar-primary-foreground": "#fafafa",
  "sidebar-accent": "#f5f5f5",
  "sidebar-accent-foreground": "#171717",
  "sidebar-border": "#e5e5e5",
  "sidebar-ring": "#a3a3a3",
};

/** Replace the active design-token palette. Called from the build
 *  pipeline after parsing the project's CSS `:root` / `.dark` blocks.
 *  Existing tokens get merged so partial palettes are additive. */
export function setThemeTokens(tokens: Record<string, string>): void {
  SHADCN_TOKENS = { ...SHADCN_TOKENS, ...tokens };
}

/** Inspect the current token table (used in tests + debug). */
export function getThemeTokens(): Record<string, string> {
  return { ...SHADCN_TOKENS };
}

function lookupColor(rest: string): string | null {
  // Split off the Tailwind `/opacity` modifier (e.g. `border/60`,
  // `black/50`, `white/[0.06]`). The modifier OVERRIDES the resolved
  // colour's alpha channel, matching Tailwind semantics.
  const slash = rest.indexOf("/");
  const base = slash < 0 ? rest : rest.slice(0, slash);
  const alphaMod = slash < 0 ? null : rest.slice(slash + 1);

  const resolved = lookupBaseColor(base);
  if (resolved === null) return null;
  return alphaMod !== null ? applyAlpha(resolved, alphaMod) : resolved;
}

function lookupBaseColor(base: string): string | null {
  // CSS keyword colours. `transparent` is critical: shadcn's Button base is
  // `border border-transparent`, so without this every button keeps the
  // default `--border` colour and paints a visible outline it shouldn't.
  // Emit a fully-transparent 8-digit hex (the scene reads #rrggbbaa) so it
  // OVERRIDES the default border colour to invisible.
  if (base === "transparent") return "#00000000";
  // shadcn / theme tokens — e.g. "muted-foreground", "background".
  // Checked before the palette lookup because they share the dash
  // syntax and a "muted-foreground" lookup would mis-resolve as
  // (name="muted", shade="foreground") otherwise.
  if (base in SHADCN_TOKENS) return SHADCN_TOKENS[base];
  // Arbitrary value — bg-[#1a1a1a], text-[#fff], border-[#666]
  if (base.startsWith("[") && base.endsWith("]")) {
    return base.slice(1, -1).replace(/_/g, " ");
  }
  // Standard Tailwind palette — "blue-500", "white", "gray-500".
  const dashIdx = base.indexOf("-");
  const name = dashIdx < 0 ? base : base.slice(0, dashIdx);
  const shade = dashIdx < 0 ? null : base.slice(dashIdx + 1);
  if (!name) return null;
  const palette = COLORS[name];
  if (!palette) return null;
  const c = shade ? palette[shade] : palette.DEFAULT ?? palette["500"];
  return c ?? null;
}

/** Apply a Tailwind opacity modifier ("60" → 60%, "[0.06]" → 6%) to a
 *  `#rrggbb`/`#rrggbbaa` colour. Tailwind v4 implements `/N` as
 *  `color-mix(in oklab, <color> N%, transparent)`, which MULTIPLIES the
 *  colour's existing alpha rather than replacing it. That distinction
 *  matters for the shadcn tokens that already carry alpha: `--border` is
 *  white@10%, so `border-border/60` is white@6% (a soft hairline) — NOT
 *  white@60% (a bright line, which is what a plain override produced and
 *  why the panel dividers looked white). Non-hex colours pass through. */
function applyAlpha(color: string, mod: string): string {
  let m: number;
  if (mod.startsWith("[") && mod.endsWith("]")) {
    m = parseFloat(mod.slice(1, -1));
  } else {
    m = parseFloat(mod) / 100;
  }
  if (Number.isNaN(m) || !color.startsWith("#")) return color;
  m = Math.max(0, Math.min(1, m));
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  // Fold in the colour's existing alpha (implicit 1.0 for a 6-digit hex).
  let existingA = 1;
  if (hex.length === 8) {
    existingA = parseInt(hex.slice(6, 8), 16) / 255;
    hex = hex.slice(0, 6);
  }
  if (hex.length !== 6) return color;
  const finalA = Math.max(0, Math.min(1, existingA * m));
  const av = Math.round(finalA * 255).toString(16).padStart(2, "0");
  return `#${hex}${av}`;
}

// Variant prefixes (Tailwind's `hover:`, `focus:`, `dark:`, `md:`, etc.).
// State variants (hover/focus/active/disabled/group-*/peer-*/aria-*/data-*)
// can't be expressed in our paint-time static style; we drop those
// classes entirely. Media + theme variants (dark/light/sm/md/lg/xl/2xl)
// are stripped and the base class is resolved — terax-ai is dark-first
// so dark: matches the active theme, and we apply all media-query base
// styles (the runtime renders at one viewport).
const STATE_VARIANTS = /^(hover|focus|focus-visible|focus-within|active|disabled|visited|checked|placeholder|group-hover|group-focus|peer-hover|peer-focus|peer-checked|first|last|odd|even|aria-[a-z-]+|data-[a-z-]+)$/;
// Pseudo-element / pseudo-class variants. These describe styling that
// should ONLY apply to the pseudo node — never to the host element.
// Our renderer doesn't model pseudo-elements, so applying their styles
// to the host (which is what would happen if we stripped just the
// variant prefix) corrupts the host's layout — e.g. `after:h-0.5`
// would set the host button to 2px tall instead of styling its
// ::after sliver. Drop the whole token here.
const PSEUDO_DROP_VARIANTS = /^(after|before|placeholder|selection|marker|file|backdrop|first-letter|first-line)$/;
// Arbitrary attribute variants like `aria-[orientation=horizontal]:` or
// `data-[state=open]:`. These describe conditional styling — they only
// apply when the element actually has that attribute. Since carbon-mini
// resolves classes statically at build time (we can't know the runtime
// attribute), we DROP the class entirely rather than applying it
// unconditionally. Without this guard, `aria-[orientation=horizontal]:h-px`
// would strip the variant and apply `h-px` always, breaking elements that
// expect the variant NOT to apply (e.g. resizable handles in vertical
// orientation).
const ARBITRARY_ATTR_VARIANT = /^(aria|data|group-aria|group-data|peer-aria|peer-data|in|not|supports)-\[/;
const APPLIED_VARIANTS = /^(dark|light|sm|md|lg|xl|2xl|portrait|landscape|motion-safe|motion-reduce|print|rtl|ltr)$/;

// Read the head segment of a class — everything up to the next `:` that
// isn't inside brackets. Tailwind arbitrary selectors can themselves
// contain `:` (e.g. `[&:nth-child(2)]:flex`), so a naive indexOf split
// over-eats and we'd drop unintended characters from the class body.
function splitFirstVariant(cls: string): { head: string; tail: string } | null {
  let depth = 0;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0) {
      return { head: cls.slice(0, i), tail: cls.slice(i + 1) };
    }
  }
  return null;
}

function stripVariants(cls: string): string | null {
  for (;;) {
    const split = splitFirstVariant(cls);
    if (!split) break;
    const { head, tail } = split;
    if (STATE_VARIANTS.test(head)) return null;
    if (ARBITRARY_ATTR_VARIANT.test(head)) return null;
    if (PSEUDO_DROP_VARIANTS.test(head)) return null;
    if (APPLIED_VARIANTS.test(head)) {
      cls = tail;
      continue;
    }
    // Unknown variant prefix — drop the WHOLE TOKEN. Falling through to
    // the base class would mean "I don't know this variant, so apply
    // the base unconditionally", which is wrong for any variant that
    // describes a conditional / pseudo / context-specific style.
    // Apps relying on a variant we don't recognize can opt-in by
    // adding it to APPLIED_VARIANTS or STATE_VARIANTS above.
    return null;
  }
  return cls;
}

/** Resolve a single Tailwind class to carbon-mini StyleProps. Returns null
 * if unknown. The compiler concatenates all known classes; unknowns get
 * preserved on the original `class` attribute so the runtime can still see them. */
export function resolveTailwindClass(raw: string): StyleProps | null {
  // Tailwind's `!important` modifier — a trailing `!` after the class
  // body or anywhere along the variant chain. We treat the styles as
  // unconditionally-applied (which is what !important means at scene
  // level) so just strip the marker. Without this `text-[13px]!`
  // wouldn't match the `[13px]` arbitrary-value branch.
  const trimmed = raw.endsWith("!") ? raw.slice(0, -1) : raw;
  const stripped = stripVariants(trimmed);
  if (stripped === null) return null;
  const cls = stripped;
  // Spacing — padding
  if (cls.startsWith("p-")) {
    const v = SPACING_SCALE[cls.slice(2)];
    return v !== undefined ? { padding: v } : null;
  }
  if (cls.startsWith("px-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-left": v, "padding-right": v } : null;
  }
  if (cls.startsWith("py-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-top": v, "padding-bottom": v } : null;
  }
  if (cls.startsWith("pt-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-top": v } : null;
  }
  if (cls.startsWith("pr-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-right": v } : null;
  }
  if (cls.startsWith("pb-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-bottom": v } : null;
  }
  if (cls.startsWith("pl-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-left": v } : null;
  }
  // Logical padding (ps-/pe- = padding-inline-start/end). LTR-aliased
  // by the runtime (no bidi/direction model) — see scene.rs's
  // inset-inline-* set_prop comment.
  if (cls.startsWith("ps-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-inline-start": v } : null;
  }
  if (cls.startsWith("pe-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "padding-inline-end": v } : null;
  }

  // Spacing — margin
  if (cls.startsWith("m-")) {
    const v = SPACING_SCALE[cls.slice(2)];
    return v !== undefined ? { margin: v } : null;
  }
  if (cls.startsWith("mx-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-left": v, "margin-right": v } : null;
  }
  if (cls.startsWith("my-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-top": v, "margin-bottom": v } : null;
  }
  if (cls.startsWith("mt-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-top": v } : null;
  }
  if (cls.startsWith("mr-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-right": v } : null;
  }
  if (cls.startsWith("mb-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-bottom": v } : null;
  }
  if (cls.startsWith("ml-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-left": v } : null;
  }
  // Logical margin (ms-/me- = margin-inline-start/end). Same LTR-alias
  // caveat as the padding pair above.
  if (cls.startsWith("ms-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-inline-start": v } : null;
  }
  if (cls.startsWith("me-")) {
    const v = SPACING_SCALE[cls.slice(3)];
    return v !== undefined ? { "margin-inline-end": v } : null;
  }

  // Gap
  if (cls.startsWith("gap-")) {
    const v = SPACING_SCALE[cls.slice(4)];
    return v !== undefined ? { gap: v } : null;
  }

  // Width / height
  if (cls.startsWith("w-")) {
    const rest = cls.slice(2);
    if (rest === "full") return { width: "100%" };
    if (rest === "screen") return { width: "100%" };
    if (rest === "auto") return { width: "auto" };
    const v = SPACING_SCALE[rest];
    if (v !== undefined) return { width: v };
  }
  if (cls.startsWith("h-")) {
    const rest = cls.slice(2);
    if (rest === "full") return { height: "100%" };
    if (rest === "screen") return { height: "100%" };
    if (rest === "auto") return { height: "auto" };
    const v = SPACING_SCALE[rest];
    if (v !== undefined) return { height: v };
  }

  // Layout
  // `flex` alone — emit both display:flex AND flex-direction:row to
  // match the CSS spec default. The scene's default flex direction is
  // column (chosen for carbon-mini's intrinsic <view>), so without the
  // explicit row override here, top bars / button rows / etc. stack
  // vertically. Later `flex-col` classes override this via merge order.
  if (cls === "flex") return { display: "flex", "flex-direction": "row" };
  if (cls === "flex-row") return { "flex-direction": "row" };
  if (cls === "flex-col") return { "flex-direction": "column" };
  if (cls === "flex-row-reverse") return { "flex-direction": "row-reverse" };
  if (cls === "flex-col-reverse") return { "flex-direction": "column-reverse" };
  if (cls.startsWith("justify-")) {
    const map: Record<string, string> = {
      start: "flex-start", end: "flex-end", center: "center",
      between: "space-between", around: "space-around", evenly: "space-evenly",
    };
    const v = map[cls.slice(8)];
    return v ? { "justify-content": v } : null;
  }
  if (cls.startsWith("items-")) {
    const map: Record<string, string> = {
      start: "flex-start", end: "flex-end", center: "center",
      stretch: "stretch", baseline: "baseline",
    };
    const v = map[cls.slice(6)];
    return v ? { "align-items": v } : null;
  }
  if (cls === "grow" || cls === "flex-grow") return { "flex-grow": 1 };
  if (cls === "shrink" || cls === "flex-shrink") return { "flex-shrink": 1 };
  if (cls === "grow-0") return { "flex-grow": 0 };
  if (cls === "shrink-0") return { "flex-shrink": 0 };

  // Typography
  if (cls.startsWith("text-")) {
    const rest = cls.slice(5);
    // text-xs / text-sm / text-base / etc.
    if (FONT_SIZE[rest] !== undefined) return { "font-size": FONT_SIZE[rest] };
    // text-{align}
    if (rest === "left" || rest === "center" || rest === "right") {
      return { "text-align": rest };
    }
    if (rest === "justify") return { "text-align": "justify" };
    if (rest === "start") return { "text-align": "left" };
    if (rest === "end") return { "text-align": "right" };
    // text-overflow: text-ellipsis / text-clip.
    if (rest === "ellipsis") return { "text-overflow": "ellipsis" };
    if (rest === "clip") return { "text-overflow": "clip" };
    // Arbitrary numeric — text-[11px], text-[1.5rem] — interpret as
    // font-size. lookupColor would treat the same string as a hex
    // colour and emit `color: "11px"` which the paint pipeline can't
    // use.
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1);
      const numericPx = inner.match(/^(-?\d+(?:\.\d+)?)px$/);
      if (numericPx) return { "font-size": Number(numericPx[1]) };
      const numericBare = Number(inner);
      if (!Number.isNaN(numericBare)) return { "font-size": numericBare };
      // Hex/named/rgb — fall through to colour lookup below.
    }
    // text-{color}
    const c = lookupColor(rest);
    if (c) return { color: c };
  }
  if (cls.startsWith("font-")) {
    const rest = cls.slice(5);
    if (FONT_WEIGHT[rest] !== undefined) return { "font-weight": FONT_WEIGHT[rest] };
  }

  // Backgrounds
  if (cls.startsWith("bg-")) {
    const rest = cls.slice(3);
    const c = lookupColor(rest);
    if (c) return { background: c };
  }

  // Borders / radius
  if (cls === "rounded") return { "border-radius": RADIUS.DEFAULT };
  if (cls.startsWith("rounded-")) {
    const v = RADIUS[cls.slice(8)];
    return v !== undefined ? { "border-radius": v } : null;
  }
  // Border width classes ALSO carry the default border colour. shadcn's
  // base layer applies `* { border-color: var(--border) }`, which carbon
  // never sees (no CSS cascade) — so without this, a bare `border` would
  // fall back to currentColor (near-white in a dark theme) and paint a
  // bright line. An explicit `border-<color>` later in the class list
  // overrides via merge order.
  const dbc = SHADCN_TOKENS.border;
  if (cls === "border") return { "border-width": 1, "border-color": dbc };
  if (cls.startsWith("border-")) {
    const rest = cls.slice(7);
    if (/^\d+$/.test(rest)) return { "border-width": Number(rest), "border-color": dbc };
    // Per-side widths: border-t / border-b / border-l / border-r and the
    // x/y pairs, each optionally with a width (border-t-2). These are how
    // shadcn/terax draw hairline separators (toolbar/header rules).
    const sideMatch = rest.match(/^([trblxy])(?:-(\d+))?$/);
    if (sideMatch) {
      const w = sideMatch[2] !== undefined ? Number(sideMatch[2]) : 1;
      const map: Record<string, StyleProps> = {
        t: { "border-top-width": w, "border-color": dbc },
        b: { "border-bottom-width": w, "border-color": dbc },
        l: { "border-left-width": w, "border-color": dbc },
        r: { "border-right-width": w, "border-color": dbc },
        x: { "border-left-width": w, "border-right-width": w, "border-color": dbc },
        y: { "border-top-width": w, "border-bottom-width": w, "border-color": dbc },
      };
      return map[sideMatch[1]];
    }
    const c = lookupColor(rest);
    if (c) return { "border-color": c };
  }

  // Opacity
  if (cls.startsWith("opacity-")) {
    const n = Number(cls.slice(8));
    if (!Number.isNaN(n)) return { opacity: n / 100 };
  }

  // ── Position
  if (cls === "static" || cls === "fixed" || cls === "absolute" || cls === "relative" || cls === "sticky") {
    return { position: cls };
  }
  if (cls === "inset-0") return { top: 0, right: 0, bottom: 0, left: 0 };
  if (cls.startsWith("inset-")) {
    const v = insetValue(cls.slice(6));
    if (v !== null) return { top: v, right: v, bottom: v, left: v };
  }
  if (cls.startsWith("top-")) {
    const v = insetValue(cls.slice(4));
    if (v !== null) return { top: v };
  }
  if (cls.startsWith("right-")) {
    const v = insetValue(cls.slice(6));
    if (v !== null) return { right: v };
  }
  if (cls.startsWith("bottom-")) {
    const v = insetValue(cls.slice(7));
    if (v !== null) return { bottom: v };
  }
  if (cls.startsWith("left-")) {
    const v = insetValue(cls.slice(5));
    if (v !== null) return { left: v };
  }
  if (cls.startsWith("z-")) {
    const v = cls.slice(2);
    if (/^\d+$/.test(v)) return { "z-index": Number(v) };
    if (v === "auto") return { "z-index": "auto" };
  }

  // ── Transform: translate (emitted as dedicated translateX/translateY
  //    scene props, NOT `transform`, because translate-x-* and translate-y-*
  //    are separate classes that would otherwise each overwrite the single
  //    `transform` prop — the paint side composes translateX+translateY+the
  //    `transform` list together). This is what centers Radix dialogs /
  //    dropdowns / tooltips (`left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`).
  if (cls.startsWith("translate-x-") || cls.startsWith("-translate-x-")) {
    const neg = cls.startsWith("-");
    const v = translateValue(cls.slice(neg ? 13 : 12), neg);
    if (v !== null) return { translateX: v };
  }
  if (cls.startsWith("translate-y-") || cls.startsWith("-translate-y-")) {
    const neg = cls.startsWith("-");
    const v = translateValue(cls.slice(neg ? 13 : 12), neg);
    if (v !== null) return { translateY: v };
  }

  // ── Display
  if (cls === "block") return { display: "block" };
  if (cls === "inline-block") return { display: "inline-block" };
  if (cls === "inline") return { display: "inline" };
  if (cls === "inline-flex") return { display: "inline-flex" };
  if (cls === "grid") return { display: "grid" };
  if (cls === "inline-grid") return { display: "inline-grid" };
  if (cls === "place-items-center")   return { "place-items": "center" };
  if (cls === "place-items-start")    return { "place-items": "start" };
  if (cls === "place-items-end")      return { "place-items": "end" };
  if (cls === "place-items-stretch")  return { "place-items": "stretch" };
  if (cls === "place-content-center") return { "place-content": "center" };
  if (cls === "place-content-start")  return { "place-content": "start" };
  if (cls === "place-content-end")    return { "place-content": "end" };
  if (cls === "place-content-between") return { "place-content": "space-between" };
  if (cls === "place-content-around") return { "place-content": "space-around" };
  if (cls === "place-self-center")    return { "place-self": "center" };
  if (cls === "place-self-start")     return { "place-self": "start" };
  if (cls === "place-self-end")       return { "place-self": "end" };
  if (cls === "place-self-stretch")   return { "place-self": "stretch" };
  if (cls === "place-self-auto")      return { "place-self": "auto" };
  // grid-cols-N / grid-rows-N — emit a CSS-grid template repeat
  // expression. Numeric N only; arbitrary templates (`grid-cols-[1fr_2fr]`)
  // need separate handling.
  if (cls.startsWith("grid-cols-")) {
    const n = parseInt(cls.slice(10), 10);
    if (Number.isFinite(n) && n > 0) return { "grid-template-columns": `repeat(${n}, minmax(0, 1fr))` };
  }
  if (cls.startsWith("grid-rows-")) {
    const n = parseInt(cls.slice(10), 10);
    if (Number.isFinite(n) && n > 0) return { "grid-template-rows": `repeat(${n}, minmax(0, 1fr))` };
  }
  if (cls.startsWith("col-span-")) {
    const n = parseInt(cls.slice(9), 10);
    if (Number.isFinite(n) && n > 0) return { "grid-column": `span ${n} / span ${n}` };
  }
  if (cls.startsWith("row-span-")) {
    const n = parseInt(cls.slice(9), 10);
    if (Number.isFinite(n) && n > 0) return { "grid-row": `span ${n} / span ${n}` };
  }
  if (cls === "col-span-full") return { "grid-column": "1 / -1" };
  if (cls === "row-span-full") return { "grid-row": "1 / -1" };
  if (cls === "col-auto") return { "grid-column": "auto" };
  if (cls === "row-auto") return { "grid-row": "auto" };
  if (cls === "hidden") return { display: "none" };
  if (cls === "contents") return { display: "contents" };

  // ── Sizing — fractions + percentages + arbitrary
  // (the `w-N` / `h-N` numeric path is earlier in the file; this block
  // catches `w-1/2`, `w-full`, `w-screen`, `w-[32px]`, etc.)
  if (cls.startsWith("w-")) {
    const v = sizeOrArbitrary(cls.slice(2));
    if (v !== null) return { width: v };
  }
  if (cls.startsWith("h-")) {
    const v = sizeOrArbitrary(cls.slice(2));
    if (v !== null) return { height: v };
  }
  if (cls.startsWith("size-")) {
    const v = sizeOrArbitrary(cls.slice(5));
    if (v !== null) return { width: v, height: v };
  }
  if (cls.startsWith("min-w-")) {
    const v = sizeOrArbitrary(cls.slice(6));
    if (v !== null) return { "min-width": v };
  }
  if (cls.startsWith("min-h-")) {
    const v = sizeOrArbitrary(cls.slice(6));
    if (v !== null) return { "min-height": v };
  }
  if (cls.startsWith("max-w-")) {
    const v = sizeOrArbitrary(cls.slice(6));
    if (v !== null) return { "max-width": v };
  }
  if (cls.startsWith("max-h-")) {
    const v = sizeOrArbitrary(cls.slice(6));
    if (v !== null) return { "max-height": v };
  }

  // ── Flex extras
  if (cls === "flex-wrap") return { "flex-wrap": "wrap" };
  if (cls === "flex-nowrap") return { "flex-wrap": "nowrap" };
  if (cls === "flex-wrap-reverse") return { "flex-wrap": "wrap-reverse" };
  if (cls === "flex-1") return { "flex-grow": 1, "flex-shrink": 1, "flex-basis": "0%" };
  if (cls === "flex-auto") return { "flex-grow": 1, "flex-shrink": 1, "flex-basis": "auto" };
  if (cls === "flex-initial") return { "flex-grow": 0, "flex-shrink": 1, "flex-basis": "auto" };
  if (cls === "flex-none") return { "flex-grow": 0, "flex-shrink": 0, "flex-basis": "auto" };
  if (cls.startsWith("basis-")) {
    const v = sizeOrArbitrary(cls.slice(6));
    if (v !== null) return { "flex-basis": v };
  }
  if (cls.startsWith("self-")) {
    const map: Record<string, string> = {
      auto: "auto", start: "flex-start", end: "flex-end", center: "center",
      stretch: "stretch", baseline: "baseline",
    };
    const v = map[cls.slice(5)];
    if (v) return { "align-self": v };
  }

  // ── Line-height / letter-spacing
  if (cls.startsWith("leading-")) {
    const rest = cls.slice(8);
    const lhMap: Record<string, number> = {
      none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2,
      "3": 12, "4": 16, "5": 20, "6": 24, "7": 28, "8": 32, "9": 36, "10": 40,
    };
    if (lhMap[rest] !== undefined) return { "line-height": lhMap[rest] };
    const arb = parseArbitraryValue(rest);
    if (arb !== null) return { "line-height": arb };
  }
  if (cls.startsWith("tracking-")) {
    const trackMap: Record<string, number> = {
      tighter: -0.8, tight: -0.4, normal: 0, wide: 0.4, wider: 0.8, widest: 1.6,
    };
    const v = trackMap[cls.slice(9)];
    if (v !== undefined) return { "letter-spacing": v };
  }

  // ── Overflow
  if (cls === "overflow-hidden") return { overflow: "hidden" };
  if (cls === "overflow-visible") return { overflow: "visible" };
  if (cls === "overflow-scroll") return { overflow: "scroll" };
  if (cls === "overflow-auto") return { overflow: "auto" };
  if (cls === "overflow-x-hidden") return { "overflow-x": "hidden" };
  if (cls === "overflow-y-hidden") return { "overflow-y": "hidden" };
  if (cls === "overflow-x-auto") return { "overflow-x": "auto" };
  if (cls === "overflow-y-auto") return { "overflow-y": "auto" };
  if (cls === "overflow-x-scroll") return { "overflow-x": "scroll" };
  if (cls === "overflow-y-scroll") return { "overflow-y": "scroll" };

  // ── Text style
  if (cls === "italic") return { "font-style": "italic" };
  if (cls === "not-italic") return { "font-style": "normal" };
  if (cls === "underline") return { "text-decoration": "underline" };
  if (cls === "line-through") return { "text-decoration": "line-through" };
  if (cls === "no-underline") return { "text-decoration": "none" };
  if (cls === "uppercase") return { "text-transform": "uppercase" };
  if (cls === "lowercase") return { "text-transform": "lowercase" };
  if (cls === "capitalize") return { "text-transform": "capitalize" };
  if (cls === "normal-case") return { "text-transform": "none" };
  if (cls === "truncate") {
    return { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" };
  }
  if (cls === "whitespace-normal") return { "white-space": "normal" };
  if (cls === "whitespace-nowrap") return { "white-space": "nowrap" };
  if (cls === "whitespace-pre") return { "white-space": "pre" };
  // pre-line/pre-wrap have no matching engine value (our white-space
  // only understands normal/nowrap/pre) — emitting them as-is is
  // harmless: set_prop stores the string but nothing branches on it,
  // so paint falls back to normal (wrap-if-width-set) behavior.
  if (cls === "whitespace-pre-wrap") return { "white-space": "pre-wrap" };
  if (cls === "whitespace-pre-line") return { "white-space": "pre-line" };

  // ── Cursor
  if (cls.startsWith("cursor-")) return { cursor: cls.slice(7) };

  // ── Visibility / pointer-events / user-select
  if (cls === "invisible") return { visibility: "hidden" };
  if (cls === "visible") return { visibility: "visible" };
  if (cls === "pointer-events-none") return { "pointer-events": "none" };
  if (cls === "pointer-events-auto") return { "pointer-events": "auto" };
  if (cls === "select-none") return { "user-select": "none" };
  if (cls === "select-text") return { "user-select": "text" };
  if (cls === "select-all") return { "user-select": "all" };
  if (cls === "select-auto") return { "user-select": "auto" };

  // ── animation. Values match Tailwind's own defaults exactly — the
  // matching `@keyframes` are pre-registered under these same names in
  // both renderers' transitions.ts (registerKeyframes("spin", ...) etc).
  if (cls === "animate-spin") return { animation: "spin 1s linear infinite" };
  if (cls === "animate-ping") return { animation: "ping 1s cubic-bezier(0,0,0.2,1) infinite" };
  if (cls === "animate-pulse") return { animation: "pulse 2s cubic-bezier(0.4,0,0.6,1) infinite" };
  if (cls === "animate-bounce") return { animation: "bounce 1s infinite" };
  if (cls === "animate-none") return { animation: "none" };

  // ── scroll-snap. `snap-x`/`snap-y` (axis) have no handler — this
  // engine only has a y scroll model, so there's no meaningful thing
  // to do with an x-axis declaration; they're silently no-ops like any
  // other unsupported value in this file.
  if (cls === "snap-mandatory") return { "scroll-snap-type": "mandatory" };
  if (cls === "snap-proximity") return { "scroll-snap-type": "proximity" };
  if (cls === "snap-none") return { "scroll-snap-type": "none" };
  if (cls === "snap-start") return { "scroll-snap-align": "start" };
  if (cls === "snap-center") return { "scroll-snap-align": "center" };
  if (cls === "snap-end") return { "scroll-snap-align": "end" };
  if (cls === "snap-align-none") return { "scroll-snap-align": "none" };

  // ── mix-blend-mode
  if (cls.startsWith("mix-blend-")) {
    const mode = cls.slice(10);
    const KNOWN = new Set([
      "normal", "multiply", "screen", "overlay", "darken", "lighten",
      "color-dodge", "color-burn", "hard-light", "soft-light",
      "difference", "exclusion", "hue", "saturation", "color", "luminosity",
    ]);
    // "plus-lighter"/"plus-darker" have no tiny-skia equivalent — fall
    // through to the unmatched/null default rather than mis-map them.
    if (KNOWN.has(mode)) return { "mix-blend-mode": mode };
  }

  // ── Outline / resize / appearance
  if (cls === "outline-none") return { "outline-width": 0 };
  // Bare `outline` — Tailwind's default outline-width is "medium" (no
  // explicit style knob on our side, so pick a visible-but-not-heavy
  // 2px default matching the common focus-ring look).
  if (cls === "outline") return { "outline-width": 2 };
  if (cls.startsWith("outline-offset-") || cls.startsWith("-outline-offset-")) {
    const neg = cls.startsWith("-");
    const rest = cls.slice(neg ? 16 : 15);
    if (/^\d+$/.test(rest)) return { "outline-offset": neg ? -Number(rest) : Number(rest) };
  }
  if (cls.startsWith("outline-")) {
    const rest = cls.slice(8);
    if (/^\d+$/.test(rest)) return { "outline-width": Number(rest) };
    // outline-dashed/-dotted/-double etc. have no matching prop (no
    // outline-style support) — fall through to the color lookup, then
    // to the unmatched/null default.
    const c = lookupColor(rest);
    if (c) return { "outline-color": c };
  }
  if (cls === "resize-none") return { resize: "none" };
  if (cls === "appearance-none") return { appearance: "none" };

  // ── aspect-ratio
  if (cls === "aspect-square") return { "aspect-ratio": "1/1" };
  if (cls === "aspect-video") return { "aspect-ratio": "16/9" };
  if (cls === "aspect-auto") return { "aspect-ratio": "auto" };
  if (cls.startsWith("aspect-[") && cls.endsWith("]")) {
    return { "aspect-ratio": cls.slice(8, -1) };
  }

  // ── filter: blur / drop-shadow. Chainable per the CSS spec — each
  // resolved class contributes one `filter` function; Tailwind expects
  // the LAST applied `blur-*`/`drop-shadow-*` class to win (like any
  // other utility), which the caller's class-merge order already gives.
  const BLUR: Record<string, number> = {
    none: 0, sm: 4, DEFAULT: 8, md: 12, lg: 16, xl: 24, "2xl": 40, "3xl": 64,
  };
  if (cls === "blur") return { filter: `blur(${BLUR.DEFAULT}px)` };
  if (cls.startsWith("blur-")) {
    const v = BLUR[cls.slice(5)];
    if (v !== undefined) return { filter: `blur(${v}px)` };
  }
  if (cls === "drop-shadow-none") return { filter: "none" };
  if (cls === "drop-shadow-sm") return { filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.05))" };
  if (cls === "drop-shadow" || cls === "drop-shadow-md") {
    return { filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.1)) drop-shadow(0 1px 1px rgba(0,0,0,0.06))" };
  }
  if (cls === "drop-shadow-lg") {
    return { filter: "drop-shadow(0 4px 4px rgba(0,0,0,0.15)) drop-shadow(0 2px 2px rgba(0,0,0,0.06))" };
  }
  if (cls === "drop-shadow-xl") {
    return { filter: "drop-shadow(0 8px 6px rgba(0,0,0,0.1)) drop-shadow(0 4px 3px rgba(0,0,0,0.08))" };
  }
  if (cls === "drop-shadow-2xl") return { filter: "drop-shadow(0 12px 10px rgba(0,0,0,0.2))" };

  // ── Shadow approximations
  if (cls === "shadow-sm") return { "box-shadow": "0 1px 2px 0 rgba(0,0,0,0.05)" };
  if (cls === "shadow") return { "box-shadow": "0 1px 3px 0 rgba(0,0,0,0.1)" };
  if (cls === "shadow-md") return { "box-shadow": "0 4px 6px -1px rgba(0,0,0,0.1)" };
  if (cls === "shadow-lg") return { "box-shadow": "0 10px 15px -3px rgba(0,0,0,0.1)" };
  if (cls === "shadow-xl") return { "box-shadow": "0 20px 25px -5px rgba(0,0,0,0.1)" };
  if (cls === "shadow-2xl") return { "box-shadow": "0 25px 50px -12px rgba(0,0,0,0.25)" };
  if (cls === "shadow-none") return { "box-shadow": "none" };

  return null;
}

// Parse a Tailwind arbitrary-value token: `[#1a1a1a]`, `[32px]`,
// `[calc(100%-2rem)]`. Returns a number when the value is a plain px
// length, otherwise the raw string for the paint pipeline.
function parseArbitraryValue(rest: string): string | number | null {
  if (!rest.startsWith("[") || !rest.endsWith("]")) return null;
  const v = rest.slice(1, -1).replace(/_/g, " ");
  const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (m) return Number(m[1]);
  const n = Number(v);
  if (!Number.isNaN(n) && /^-?\d/.test(v)) return n;
  return v;
}

// Spacing-scale OR arbitrary; used by `top-`/`left-`/etc.
function spacingOrArbitrary(rest: string): string | number | null {
  if (rest in SPACING_SCALE) return SPACING_SCALE[rest];
  return parseArbitraryValue(rest);
}

// Inset value: fractions/percentages (top-1/2 → "50%", inset-full → "100%")
// first, then the spacing scale / arbitrary. Absolute-positioned Radix
// overlays and the search-icon `top-1/2 -translate-y-1/2` pattern depend on
// the percentage form resolving.
function insetValue(rest: string): string | number | null {
  if (rest in SIZE_FRACTIONS) return SIZE_FRACTIONS[rest];
  return spacingOrArbitrary(rest);
}

// Sizing — accepts spacing scale, percentage fractions, full/screen
// keywords, and arbitrary values. Used by `w-*` / `h-*` / `min-*` /
// `max-*` / `basis-*` / `size-*`.
const SIZE_FRACTIONS: Record<string, string> = {
  "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%",
  "1/4": "25%", "2/4": "50%", "3/4": "75%",
  "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%",
  "1/6": "16.666667%", "5/6": "83.333333%",
  "1/12": "8.333333%", "2/12": "16.666667%", "3/12": "25%",
  "4/12": "33.333333%", "5/12": "41.666667%", "6/12": "50%",
  "7/12": "58.333333%", "8/12": "66.666667%", "9/12": "75%",
  "10/12": "83.333333%", "11/12": "91.666667%",
  full: "100%", screen: "100%", auto: "auto",
  min: "min-content", max: "max-content", fit: "fit-content",
};

function sizeOrArbitrary(rest: string): string | number | null {
  if (rest in SIZE_FRACTIONS) return SIZE_FRACTIONS[rest];
  if (rest in SPACING_SCALE) return SPACING_SCALE[rest];
  if (rest.endsWith("vh") || rest.endsWith("vw")) return rest;
  return parseArbitraryValue(rest);
}

// translate-x-* / translate-y-* value: fractions (1/2 → 50%), full (100%),
// arbitrary ([-50%], [10px]), or the spacing scale (translate-x-2 → 8px).
// `neg` negates the result (for `-translate-x-1/2`). Returns a CSS length /
// percentage string (or px number); the scene parses % against the element's
// own size, matching CSS translate semantics.
function translateValue(rest: string, neg: boolean): string | number | null {
  let base: string | number | null = null;
  if (rest in SIZE_FRACTIONS && SIZE_FRACTIONS[rest].endsWith("%")) {
    base = SIZE_FRACTIONS[rest];
  } else if (rest === "full") {
    base = "100%";
  } else if (rest.startsWith("[") && rest.endsWith("]")) {
    base = parseArbitraryValue(rest);
  } else if (rest in SPACING_SCALE) {
    base = SPACING_SCALE[rest];
  }
  if (base === null) return null;
  if (!neg) return base;
  // Negate: numbers directly, strings by flipping a leading sign.
  if (typeof base === "number") return -base;
  return base.startsWith("-") ? base.slice(1) : `-${base}`;
}
