// Pulls design tokens out of a project's CSS so the Tailwind class
// compiler stops hardcoding shadcn's defaults. shadcn-style apps put
// their theme in `:root { --foo: ...; }` blocks (with `.dark { ... }`
// overrides); we parse those at build time and feed the resolved
// palette into `classes.ts`.
//
// OKLCH support: shadcn defaults use OKLCH for perceptual uniformity.
// Tailwind v4 also accepts hex/rgb/hsl in :root; we handle all the
// shapes we've seen in real apps.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type ThemeTokens = Record<string, string>;

/** Parse a CSS file's :root and .dark blocks, returning normalized
 *  hex colors keyed by variable name (no leading `--`). Light variant
 *  uses :root; if `.dark` is present and `mode === "dark"` is requested
 *  it's preferred. */
export function extractThemeTokens(
  css: string,
  mode: "light" | "dark" = "light",
): ThemeTokens {
  const out: ThemeTokens = {};
  const lightBlock = matchBlock(css, /(?:^|[\s}])(:root)\s*\{([^}]*)\}/);
  const darkBlock = matchBlock(css, /(?:^|[\s}])(\.dark)\s*\{([^}]*)\}/);

  // Light always provides defaults; dark overlays when selected.
  if (lightBlock) parseDecls(lightBlock, out);
  if (mode === "dark" && darkBlock) parseDecls(darkBlock, out);
  return out;
}

/** Find the first matching CSS block — returns the declarations body
 *  without the surrounding braces, or null if no match. */
function matchBlock(css: string, re: RegExp): string | null {
  const m = re.exec(css);
  if (!m) return null;
  return m[2];
}

/** Split a block body into `--name: value;` declarations and store
 *  each one normalized to hex. */
function parseDecls(body: string, out: ThemeTokens): void {
  // Strip line comments + multi-line comments.
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = cleaned.split(";");
  for (const d of decls) {
    const idx = d.indexOf(":");
    if (idx < 0) continue;
    const rawName = d.slice(0, idx).trim();
    const rawValue = d.slice(idx + 1).trim();
    if (!rawName.startsWith("--")) continue;
    const name = rawName.slice(2);
    const hex = normalizeColor(rawValue);
    if (hex) out[name] = hex;
  }
}

/** Coerce a CSS color literal (oklch/oklab/rgb/hsl/hex/named) into
 *  `#rrggbb`. Returns null for non-color values (radii, opacity, etc.)
 *  — those don't belong in the color-token table. */
export function normalizeColor(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("#")) return normalizeHex(v);

  const oklch = parseFn(v, "oklch");
  if (oklch) return rgbToHex(oklchToSrgb(oklch.comps), oklch.alpha);

  const oklab = parseFn(v, "oklab");
  if (oklab) return rgbToHex(oklabToSrgb(oklab.comps), oklab.alpha);

  const rgb = parseFn(v, "rgb") ?? parseFn(v, "rgba");
  if (rgb) return rgbToHex({ r: rgb.comps[0] / 255, g: rgb.comps[1] / 255, b: rgb.comps[2] / 255 }, rgb.alpha);

  const hsl = parseFn(v, "hsl") ?? parseFn(v, "hsla");
  if (hsl) return rgbToHex(hslToSrgb(hsl.comps[0], hsl.comps[1], hsl.comps[2]), hsl.alpha);

  // var() / calc() / unitless / pixel values → not a color.
  return null;
}

function normalizeHex(s: string): string | null {
  const hex = s.replace(/^#/, "");
  if (hex.length === 3) {
    return "#" + hex.split("").map((c) => c + c).join("").toLowerCase();
  }
  if (hex.length === 6) return ("#" + hex).toLowerCase();
  // Preserve the alpha byte — the paint pipeline blends #rrggbbaa, and
  // dropping it turns translucent tokens (borders, overlays) opaque.
  if (hex.length === 8) return ("#" + hex).toLowerCase();
  return null;
}

/** Parse a CSS alpha token ("0.1" or "10%") into 0..1. */
function parseAlphaToken(t: string): number {
  const s = t.trim();
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 1;
  return s.endsWith("%") ? n / 100 : n;
}

/** Pull a `name(a b c [/ alpha])` or `name(a, b, c [, alpha])` arg list,
 *  keeping the alpha channel so translucent tokens survive to the paint
 *  pipeline (which blends 8-digit-hex colours). */
function parseFn(s: string, name: string): { comps: number[]; alpha: number } | null {
  const re = new RegExp(`^${name}\\(([^)]+)\\)$`, "i");
  const m = re.exec(s);
  if (!m) return null;
  const [body, alphaRaw] = m[1].split("/");
  const comps = body.trim().split(/[\s,]+/).map((p) => parseFloat(p));
  if (comps.some((p) => Number.isNaN(p))) return null;
  let alpha = 1;
  if (alphaRaw !== undefined) {
    // Modern slash syntax: `oklch(L C H / a)`, `rgb(r g b / a)`.
    alpha = parseAlphaToken(alphaRaw);
  } else if (comps.length === 4) {
    // Legacy comma syntax: `rgba(r,g,b,a)` / `hsla(h,s,l,a)`.
    alpha = comps[3];
    comps.length = 3;
  }
  return { comps, alpha };
}

// ─── OKLCH → sRGB ─────────────────────────────────────────────────────────
// Reference: https://bottosson.github.io/posts/oklab/
// Two-step pipeline: OKLCH → OKLab → linear-sRGB → sRGB.

function oklchToSrgb([L, C, h]: number[]): RGB {
  const hRad = (h * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  return oklabToSrgb([L, a, b]);
}

function oklabToSrgb([L, a, b]: number[]): RGB {
  // OKLab → linear sRGB via the LMS intermediate from Björn Ottosson's
  // OKLab paper.
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  let r =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  // linear → gamma-encoded sRGB
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(bl) };
}

function linearToSrgb(c: number): number {
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c <= 0.0031308
    ? 12.92 * c
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

interface RGB { r: number; g: number; b: number; }

function rgbToHex({ r, g, b }: RGB, alpha = 1): string {
  const c = (x: number) => {
    const n = Math.round(Math.max(0, Math.min(1, x)) * 255);
    return n.toString(16).padStart(2, "0");
  };
  const base = `#${c(r)}${c(g)}${c(b)}`;
  // Fully-opaque → 6-digit hex (the common case). Translucent → append
  // the alpha byte so the paint pipeline can blend it.
  if (alpha >= 1) return base;
  return base + c(Math.max(0, Math.min(1, alpha)));
}

function hslToSrgb(h: number, sPct: number, lPct: number): RGB {
  const s = sPct / 100, l = lPct / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

/** Walk the project for an entry CSS file. Apps typically import
 *  `./styles/globals.css` from main.tsx; we look for that path first,
 *  then for a few common alternates. Returns null if none found. */
export function findProjectThemeCss(projectDir: string): string | null {
  const candidates = [
    "src/styles/globals.css",
    "src/styles/index.css",
    "src/index.css",
    "src/styles.css",
    "src/app.css",
    "styles/globals.css",
    "styles.css",
    "globals.css",
  ];
  for (const rel of candidates) {
    const full = join(projectDir, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Read + parse the project's theme tokens in one call. Used by the
 *  build pipeline to inject a project-specific palette into
 *  `resolveTailwindClass`. */
export function loadProjectThemeTokens(
  projectDir: string,
  mode: "light" | "dark" = "light",
): ThemeTokens {
  const file = findProjectThemeCss(projectDir);
  if (!file) return {};
  try {
    return extractThemeTokens(readFileSync(file, "utf8"), mode);
  } catch {
    return {};
  }
}
