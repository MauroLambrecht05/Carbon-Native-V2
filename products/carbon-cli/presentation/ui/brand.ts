// carbon's visual identity in the terminal: the dot-matrix wordmark shown
// once at the top of `dev`/`run`/`build`, and the "ready" summary printed
// once preparation finishes. Hand-rolled — no Ink, no figlet, no
// gradient-string.
//
// ── WHY DOTS, NOT BLOCKS ─────────────────────────────────────────────────────
// The first version used solid █ block characters on a 6-row bitmap — direct
// per the user, "too blocky... use dots". This version packs the letterforms
// into Unicode Braille patterns (U+2800 block): each terminal cell holds a
// 2-wide x 4-tall sub-pixel grid, so the wordmark is built from small round
// dots rather than solid rectangles.
//
// v2: the first dot version still read as "bland" — thin, single-dot-wide
// strokes and square corners. This one starts from the same validated 5x7
// letterforms, scales each pixel to a 3x3 block for real stroke weight, then
// algorithmically nicks the single outer sub-pixel of every exposed convex
// corner (top-left/top-right/bottom-left/bottom-right of each source pixel
// that has no orthogonal neighbor on those two sides) — a cheap, reliable
// round-over that doesn't require hand-placing diagonal dots.
//
// The bitmap is authored as plain '#'/'.' ascii art and precomputed into the
// braille strings below rather than rebuilt at runtime — the letterforms are
// fixed, so there's nothing to gain from redoing that work on every command
// invocation. See the scratch generator this was designed with for the full
// scale+round algorithm if the wordmark ever needs to change.
//
// ── WHY THIS LIBRARY-FREE ────────────────────────────────────────────────────
// Ink needs exclusive ownership of stdout to do its redraw diffing, which
// conflicts with `carbon dev`/`run` inheriting the spawned app's own stdio
// directly (see status-line.ts's doc comment for the same reasoning applied
// to the status line). A bitmap + a gradient formula has no such requirement
// and costs zero new dependencies.

import { c } from "@carbon/logging";

/** The wordmark, pre-packed into braille — see the module doc comment. Each
 *  line is 53 terminal columns wide (106 sub-pixels / 2), 6 lines tall. */
const WORDMARK: readonly string[] = [
  "⢀⠐⠿⠿⠿⠗⢀⠀⠀⠀⠀⡀⠺⠂⡀⠀⠀⠀⣾⡿⠿⠿⠿⠗⢀⠀⠀⣾⡿⠿⠿⠿⠗⢀⠀⠀⢀⠐⠿⠿⠿⠗⢀⠀⠀⣾⣆⡀⠀⠀⠀⣾⡆",
  "⣿⡇⠀⠀⠀⠀⠙⠁⠀⣠⡈⠋⠀⠈⠋⣠⡀⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⡟⠋⣠⡀⠀⣿⡇",
  "⣿⡇⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⣷⣶⣶⣶⡦⠈⠀⠀⣿⣷⣶⣶⣶⡦⠈⠀⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⡇⠀⢿⠇⠀⣿⡇",
  "⣿⡇⠀⠀⠀⠀⢀⠀⠀⣿⡿⠿⠿⠿⠿⣿⡇⠀⣿⡇⠀⠻⠃⡀⠀⠀⠀⣿⡇⠀⠀⠀⠀⣾⡆⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⡇⠀⠀⠐⠿⣿⡇",
  "⠙⢁⣤⣤⣤⣄⠙⠁⠀⣿⡇⠀⠀⠀⠀⣿⡇⠀⣿⡇⠀⠀⠈⠋⣠⡀⠀⣿⣧⣤⣤⣤⣄⠙⠁⠀⠙⢁⣤⣤⣤⣄⠙⠁⠀⣿⡇⠀⠀⠀⠀⣿⡇",
  "⠀⠀⠉⠉⠉⠁⠀⠀⠀⠈⠀⠀⠀⠀⠀⠈⠀⠀⠈⠀⠀⠀⠀⠀⠈⠀⠀⠈⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠉⠉⠉⠁⠀⠀⠀⠈⠀⠀⠀⠀⠀⠈⠀",
];
const WORDMARK_WIDTH = WORDMARK[0]!.length;

// The brand accent — a mint/seafoam green, not the cyan-violet this
// replaced. The first pass (148,233,200) → (70,200,165) was too narrow a
// range to read as a gradient at all across the banner's width — this widens
// it to a real light-to-dark sweep (near-white mint down to a deep saturated
// teal) while staying in the same hue family, so it's visibly a gradient
// without turning into a second, unrelated brand color.
const GRADIENT_FROM: readonly [number, number, number] = [214, 255, 238]; // near-white mint
const GRADIENT_TO: readonly [number, number, number] = [16, 138, 108]; // deep saturated teal
/** Flat accent for everything that isn't the wordmark — arrows, the spinner,
 *  success marks — one fixed point partway through the gradient so small UI
 *  elements read as the same brand color rather than a random gradient slice. */
const ACCENT: readonly [number, number, number] = [92, 219, 179];

function rgb([r, g, b]: readonly [number, number, number]): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}
const RESET = "\x1b[0m";

/** Wraps `text` in the flat brand accent color (mint) when the terminal
 *  supports color, otherwise returns it unchanged. */
export function accent(text: string): string {
  return c.isColorSupported ? `${rgb(ACCENT)}${text}${RESET}` : text;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Colors one line of the wordmark, sampling the gradient by each dot
 *  character's column position — `totalWidth` is the whole banner's width
 *  (not this line's), so every row samples the same left-to-right sweep. */
function gradientLine(line: string, totalWidth: number): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "⠀") {
      // U+2800 BRAILLE PATTERN BLANK — the "empty dot cell" glyph, not a
      // space. Skip coloring it same as a space; it renders as blank either way.
      out += ch;
      continue;
    }
    const t = totalWidth <= 1 ? 0 : i / (totalWidth - 1);
    const r = lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t);
    const g = lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t);
    const b = lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t);
    out += `\x1b[38;2;${r};${g};${b}m${ch}`;
  }
  return out + RESET;
}

/** Prints the CARBON wordmark once, followed by a bold subtitle naming what
 *  this run of the CLI is doing ("dev server", "build", "run"). Printed
 *  immediately, before any prep work starts — the point is that the tool
 *  has a face before it has anything to report. */
export function printBanner(subtitle: string): void {
  const out = process.stdout;
  out.write("\n");
  if (c.isColorSupported) {
    for (const line of WORDMARK) out.write(`  ${gradientLine(line, WORDMARK_WIDTH)}\n`);
  } else {
    for (const line of WORDMARK) out.write(`  ${line}\n`);
  }
  out.write(`\n  ${c.bold(subtitle)}\n`);
}

/** The "ready" summary — one line per fact, arrow-prefixed, printed once
 *  preparation succeeds. `hotkeys`, when given, is the last row (only
 *  `dev` has real ones to offer; `run`/`build` omit it). */
export function printReadySummary(opts: {
  appName: string;
  version?: string;
  backend: string;
  elapsedMs: number;
  hmr?: boolean;
  hotkeys?: string;
}): void {
  const out = process.stdout;
  out.write(`\n  ${c.dim("ready in")} ${accent(c.bold(`${Math.round(opts.elapsedMs)}ms`))}\n\n`);

  const rows: Array<[string, string]> = [
    ["app", `${c.bold(opts.appName)}${opts.version ? c.dim(` v${opts.version}`) : ""}`],
    ["backend", `${opts.backend}${opts.hmr ? c.dim(" · HMR on") : ""}`],
  ];
  if (opts.hotkeys) rows.push(["hotkeys", opts.hotkeys]);

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    out.write(`  ${accent("➜")}  ${c.dim(label.padEnd(labelWidth))}  ${value}\n`);
  }
  out.write("\n");
}

/** One line per successful rebuild in `carbon dev` — replaces the multi-line
 *  "building…" / "[carbon-tailwind]…" dump the pipeline produces internally
 *  (folded into the StatusLine while the rebuild runs, then discarded).
 *  Timestamped so a fast burst of saves stays legible in scrollback. */
export function printRebuildLine(ms: number, opts: { hmr: boolean }): void {
  const time = new Date().toLocaleTimeString();
  process.stdout.write(
    `${c.dim(time)}  ${accent("✓")} rebuilt in ${Math.round(ms)}ms` +
      `${opts.hmr ? c.dim(" · hot-reloaded") : c.dim(" · relaunching")}\n`,
  );
}
