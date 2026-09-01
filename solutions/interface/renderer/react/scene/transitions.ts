// CSS transitions.
//
// Ported from the Solid renderer's scene/transitions.ts, which had this
// system and this renderer didn't — every prop change on a React-rendered
// node was an instant jump, `transition` was a no-op. Framework-agnostic
// (only touches CmNode + the __cm_* host imports both renderers share), so
// this is the same file with its imports re-pointed at this renderer's own
// node.ts/host/imports.ts. Keep the two in sync by hand; neither renderer
// depends on the other's scene/ module.

import "../host/imports.ts";
import type { CmNode } from "./node.ts";

// ─── CSS transitions ─────────────────────────────────────────────────────
//
// When a node has a `transition` style and one of its animatable props
// changes, we tween from the previous value to the new one over the
// configured duration. Driven by the same rAF loop the runtime
// already supports, so transitions cost a single frame-rate poll
// while any are active and zero when idle.
//
// What's supported:
//   - Numeric values (width, height, padding, top/left/etc., opacity,
//     fontSize, borderRadius, letterSpacing). Bare numbers and "px"
//     suffixes both parse.
//   - Color values (background, color) as hex, rgb(...), rgba(...).
//     Interpolated channel-by-channel.
//
// What's not (yet):
//   - transform interpolation (rotate/scale need decomposition)
//   - per-property durations specified separately from a shorthand

interface TransitionSpec {
  /** Duration in ms. */
  duration: number;
  /** Easing function: maps t∈[0,1] → t'∈[0,1]. */
  ease: (t: number) => number;
  /** Delay before the tween starts, in ms. */
  delay: number;
}

interface ActiveTween {
  node: CmNode;
  propName: string;
  from: any;
  to: any;
  start: number;
  spec: TransitionSpec;
  /** True for color tweens — interpolates RGBA channels. */
  isColor: boolean;
}

export const transitionConfig = new Map<number, Map<string, TransitionSpec>>();
/** Map of propName → last applied value, used as the tween's `from`
 *  on the next set. Keyed by node id then prop name. */
export const lastAppliedValues = new Map<number, Map<string, any>>();
export const activeTweens = new Map<string, ActiveTween>();
let tweenRafId: number | null = null;

const ANIMATABLE_PROPS = new Set([
  "width", "height", "top", "left", "right", "bottom",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "fontSize", "font-size",
  "borderRadius", "border-radius",
  "letterSpacing", "letter-spacing",
  "lineHeight", "line-height",
  "opacity",
  "color", "background", "backgroundColor", "background-color",
]);

const COLOR_PROPS = new Set([
  "color", "background", "backgroundColor", "background-color",
]);

/** Build a CSS `cubic-bezier(x1, y1, x2, y2)` easing function: solves
 *  x(t) = progress for t (Newton-Raphson, falling back to bisection when
 *  it doesn't converge — steep curves near t=0/1 can overshoot), then
 *  evaluates y(t). Same construction as WebKit's UnitBezier, which is
 *  also what the CSS keywords below are literally defined in terms of. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const A = (a1: number, a2: number) => 1.0 - 3.0 * a2 + 3.0 * a1;
  const B = (a1: number, a2: number) => 3.0 * a2 - 6.0 * a1;
  const C = (a1: number) => 3.0 * a1;

  const bezier = (t: number, a1: number, a2: number) =>
    ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
  const bezierSlope = (t: number, a1: number, a2: number) =>
    3.0 * A(a1, a2) * t * t + 2.0 * B(a1, a2) * t + C(a1);

  function solveT(x: number): number {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = bezier(t, x1, x2) - x;
      const slope = bezierSlope(t, x1, x2);
      if (Math.abs(slope) < 1e-6) break;
      t -= dx / slope;
    }
    if (t >= 0 && t <= 1 && Math.abs(bezier(t, x1, x2) - x) < 1e-4) return t;
    // Bisection fallback — guaranteed to converge for a monotonic x(t)
    // (true whenever x1/x2 are both in [0, 1], which every CSS-valid
    // cubic-bezier value is).
    let lo = 0;
    let hi = 1;
    let guess = x;
    for (let i = 0; i < 20; i++) {
      const cur = bezier(guess, x1, x2);
      if (Math.abs(cur - x) < 1e-6) break;
      if (cur < x) lo = guess; else hi = guess;
      guess = (lo + hi) / 2;
    }
    return guess;
  }

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return bezier(solveT(t), y1, y2);
  };
}

/** Resolve a named easing keyword or `cubic-bezier(x1,y1,x2,y2)` into a
 *  t -> t' function. The named keywords are CSS's own cubic-bezier
 *  definitions, not approximations of them. */
export function easeFromName(name: string): (t: number) => number {
  const cb = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(
    name.trim(),
  );
  if (cb) {
    return cubicBezier(parseFloat(cb[1]), parseFloat(cb[2]), parseFloat(cb[3]), parseFloat(cb[4]));
  }
  switch (name) {
    case "linear": return (t) => t;
    case "ease-in": return cubicBezier(0.42, 0.0, 1.0, 1.0);
    case "ease-out": return cubicBezier(0.0, 0.0, 0.58, 1.0);
    case "ease-in-out": return cubicBezier(0.42, 0.0, 0.58, 1.0);
    case "ease":
    default:
      return cubicBezier(0.25, 0.1, 0.25, 1.0);
  }
}

/** Parse a duration token: "200ms", "0.3s", "300". Returns ms. */
function parseDuration(tok: string): number {
  const t = tok.trim();
  if (t.endsWith("ms")) return parseFloat(t.slice(0, -2)) || 0;
  if (t.endsWith("s")) return (parseFloat(t.slice(0, -1)) || 0) * 1000;
  return parseFloat(t) || 0;
}

/** Parse a `transition` shorthand value. Multiple transitions are
 *  comma-separated. Each is `<prop> <duration> [<easing>] [<delay>]`,
 *  with `all` as the wildcard prop. */
export function parseTransition(value: string): Map<string, TransitionSpec> {
  const result = new Map<string, TransitionSpec>();
  if (!value || typeof value !== "string") return result;
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const toks = part.split(/\s+/);
    if (toks.length < 2) continue;
    const prop = toks[0];
    const duration = parseDuration(toks[1]);
    let easing = "ease";
    let delay = 0;
    for (let i = 2; i < toks.length; i++) {
      const t = toks[i];
      if (t.endsWith("ms") || t.endsWith("s") || /^\d/.test(t)) {
        delay = parseDuration(t);
      } else {
        easing = t;
      }
    }
    result.set(prop, {
      duration,
      ease: easeFromName(easing),
      delay,
    });
  }
  return result;
}

/** Look up the transition spec applicable to a prop on a node.
 *  Returns null if no transition is configured or duration is 0. */
function getTransitionFor(nodeId: number, propName: string): TransitionSpec | null {
  const map = transitionConfig.get(nodeId);
  if (!map) return null;
  const exact = map.get(propName) ?? map.get("all");
  if (!exact || exact.duration <= 0) return null;
  return exact;
}

/** Parse a value into a number (px or unitless). Returns null if not numeric. */
function parseNumeric(v: any): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.endsWith("px")) {
    const n = parseFloat(t.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) && /^-?\d/.test(t) ? n : null;
}

/** Parse a color string into RGBA channels (0-255 each). Returns null
 *  if unrecognised. Supports #rgb / #rrggbb / #rrggbbaa / rgb(...) /
 *  rgba(...) — same subset the Rust parser handles. */
function parseColor(s: any): [number, number, number, number] | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.startsWith("#")) {
    const hex = t.slice(1);
    const parseHex2 = (str: string) => parseInt(str, 16);
    if (hex.length === 3) {
      return [
        parseHex2(hex[0] + hex[0]),
        parseHex2(hex[1] + hex[1]),
        parseHex2(hex[2] + hex[2]),
        255,
      ];
    }
    if (hex.length === 6) {
      return [parseHex2(hex.slice(0, 2)), parseHex2(hex.slice(2, 4)), parseHex2(hex.slice(4, 6)), 255];
    }
    if (hex.length === 8) {
      return [
        parseHex2(hex.slice(0, 2)),
        parseHex2(hex.slice(2, 4)),
        parseHex2(hex.slice(4, 6)),
        parseHex2(hex.slice(6, 8)),
      ];
    }
    return null;
  }
  const m = t.match(/^rgba?\(\s*([^)]+)\)\s*$/i);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return null;
    const a = parts[3] != null ? Math.round(parts[3] * 255) : 255;
    return [parts[0], parts[1], parts[2], a];
  }
  return null;
}

function formatColor(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${(a / 255).toFixed(3)})`;
}

function tweenKey(nodeId: number, propName: string): string {
  return `${nodeId}::${propName}`;
}

function startTween(node: CmNode, propName: string, from: any, to: any, spec: TransitionSpec) {
  // Color or numeric? Try color first since some props can be either.
  let isColor = false;
  if (COLOR_PROPS.has(propName)) {
    const c1 = parseColor(from);
    const c2 = parseColor(to);
    if (c1 && c2) {
      isColor = true;
    } else {
      // Either side unparseable — skip the tween, set directly.
      return false;
    }
  } else {
    const n1 = parseNumeric(from);
    const n2 = parseNumeric(to);
    if (n1 == null || n2 == null) return false;
  }
  const key = tweenKey(node.id, propName);
  // Cancel any existing tween on this prop; the new one supersedes.
  activeTweens.delete(key);
  activeTweens.set(key, {
    node,
    propName,
    from,
    to,
    start: performance.now() + spec.delay,
    spec,
    isColor,
  });
  ensureTweenLoop();
  return true;
}

function ensureTweenLoop() {
  if (tweenRafId != null) return;
  tweenRafId = (globalThis as any).requestAnimationFrame(tickTweens);
}

function tickTweens(now: number) {
  tweenRafId = null;
  if (activeTweens.size === 0) return;
  const finished: string[] = [];
  for (const [key, tween] of activeTweens) {
    const elapsed = now - tween.start;
    if (elapsed < 0) continue; // delay still active
    const dur = tween.spec.duration;
    const raw = dur > 0 ? Math.min(elapsed / dur, 1) : 1;
    const t = tween.spec.ease(raw);
    let interp: any;
    if (tween.isColor) {
      const c1 = parseColor(tween.from)!;
      const c2 = parseColor(tween.to)!;
      const r = c1[0] + (c2[0] - c1[0]) * t;
      const g = c1[1] + (c2[1] - c1[1]) * t;
      const b = c1[2] + (c2[2] - c1[2]) * t;
      const a = c1[3] + (c2[3] - c1[3]) * t;
      interp = formatColor(r, g, b, a);
    } else {
      const n1 = parseNumeric(tween.from)!;
      const n2 = parseNumeric(tween.to)!;
      interp = n1 + (n2 - n1) * t;
    }
    // Apply directly through the host import — bypass setProperty so
    // we don't recurse into startTween on every frame.
    __cm_set_prop(tween.node.id, tween.propName, JSON.stringify(interp));
    if (raw >= 1) {
      finished.push(key);
    }
  }
  for (const key of finished) activeTweens.delete(key);
  if (activeTweens.size > 0) {
    ensureTweenLoop();
  }
  __cm_request_paint();
}

/** Hook into setProperty: if the prop is animatable AND the node has
 *  a transition for it AND the last-applied value differs from the
 *  new value, start a tween. Returns true when a tween was started
 *  (caller should skip the immediate __cm_set_prop write). */
export function maybeStartTransition(node: CmNode, name: string, value: any): boolean {
  if (!ANIMATABLE_PROPS.has(name)) return false;
  const spec = getTransitionFor(node.id, name);
  if (!spec) return false;
  const lastMap = lastAppliedValues.get(node.id);
  const from = lastMap?.get(name);
  if (from === undefined || from === value) return false;
  return startTween(node, name, from, value, spec);
}

export function recordAppliedValue(nodeId: number, name: string, value: any) {
  let m = lastAppliedValues.get(nodeId);
  if (!m) { m = new Map(); lastAppliedValues.set(nodeId, m); }
  m.set(name, value);
}

// ─── CSS `@keyframes` + `animation` ─────────────────────────────────────
//
// A second, independent tween system alongside the one above: `transition`
// tweens FROM the last value TO a new one on prop change; `animation` loops
// through a named, pre-registered set of keyframe stops on its own clock,
// with no "new value" to react to. Built on the same primitives (rAF loop,
// `easeFromName`, the numeric/color interpolators above) plus one this file
// didn't have: transform decomposition, since spin/bounce-style animations
// are exactly the case the file's own old "not (yet)" note called out.
//
// What's supported:
//   - Multiple keyframe stops (not just from/to), percentage or from/to
//     selectors, comma-shared selectors ("0%, 100%").
//   - The same numeric/color props `transition` interpolates, PLUS
//     `transform` — parsed into its function calls (`rotate(Xdeg)`,
//     `translateY(X%)`, ...) and interpolated arg-by-arg when both
//     keyframe stops use the same function list; snaps at the midpoint
//     when they don't (nothing meaningful to interpolate between, e.g.
//     `rotate(...)` vs `scale(...)`).
//   - `animation-duration/-timing-function/-delay/-iteration-count/
//     -direction` via the single `animation` shorthand (matches this
//     file's `transition` — no separate longhand props either).
//   - `infinite`, and `alternate`/`reverse`/`alternate-reverse` direction.
//
// What's not:
//   - Only ONE animation per node (a comma-separated list picks the LAST).
//   - `animation-fill-mode` is parsed but not applied — every animation
//     behaves as `forwards` (stays on its last frame when it ends), which
//     is what `infinite` (Tailwind's `animate-*` classes, the overwhelmingly
//     common case) already does implicitly. A finite, non-infinite
//     animation wanting `none`/`backwards` reversion would need a
//     pre-animation-baseline snapshot this file doesn't keep.
//   - `animation-play-state` (pause/resume).
//   - Per-keyframe-stop `animation-timing-function` DOES work — author
//     it as an ordinary property inside the keyframe block (matching
//     real CSS syntax: `"0%": { transform: "...", "animation-timing-
//     function": "cubic-bezier(...)" }`), same as Tailwind's actual
//     `bounce` uses it (`cubic-bezier(0.8,0,1,1)` falling, `cubic-
//     bezier(0,0,0.2,1)` rising — not one curve smoothed across the
//     whole cycle, which is what a plain `animation: bounce 1s infinite`
//     with no per-stop override would look like). It overrides the
//     shorthand's own easing for just that segment; segments without
//     one fall back to it.

type KeyframeProps = Record<string, string | number>;
interface KeyframeStop {
  offset: number;
  props: KeyframeProps;
  /** Parsed from an `"animation-timing-function"` entry in this stop's
   *  own props (real CSS syntax — not a separate API). Governs the
   *  segment STARTING at this stop; `undefined` falls back to the
   *  animation's own shorthand easing. */
  easing?: (t: number) => number;
}
type KeyframeSet = KeyframeStop[];

const keyframeRegistry = new Map<string, KeyframeSet>();

/** Register a named `@keyframes` animation for later use via
 *  `animation: <name> ...`. `frames` keys are CSS keyframe selectors —
 *  "0%".."100%", "from"/"to", or a comma list ("0%, 100%"); values are
 *  the same style-prop shape `style={{}}` accepts, PLUS the optional
 *  `"animation-timing-function"` pseudo-prop (real CSS syntax) to
 *  override easing for just that segment. Call before any element
 *  references the name. Re-registering a name replaces it (an
 *  already-running animation keeps its OLD keyframe list until it next
 *  restarts — same "don't rewrite state out from under a live tween"
 *  principle `maybeStartTransition` follows). */
export function registerKeyframes(name: string, frames: Record<string, KeyframeProps>): void {
  const set: KeyframeSet = [];
  for (const [selector, rawProps] of Object.entries(frames)) {
    const props: KeyframeProps = { ...rawProps };
    let easing: ((t: number) => number) | undefined;
    const tf = props["animation-timing-function"];
    if (typeof tf === "string") {
      easing = easeFromName(tf);
      delete props["animation-timing-function"];
    }
    for (const tok of selector.split(",")) {
      const t = tok.trim();
      let offset: number | null = null;
      if (t === "from") offset = 0;
      else if (t === "to") offset = 1;
      else if (t.endsWith("%")) {
        const n = parseFloat(t.slice(0, -1));
        if (Number.isFinite(n)) offset = n / 100;
      }
      if (offset != null) set.push({ offset, props, easing });
    }
  }
  set.sort((a, b) => a.offset - b.offset);
  keyframeRegistry.set(name, set);
}

// Tailwind's four built-in animations, registered up front so the
// `animate-spin`/`-ping`/`-pulse`/`-bounce` utility classes work without
// the app registering anything itself. Values match Tailwind's own
// defaults exactly (same durations/easings/keyframe percentages/
// per-stop timing-function overrides).
registerKeyframes("spin", {
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});
registerKeyframes("ping", {
  "0%": { transform: "scale(1)", opacity: 1 },
  "75%, 100%": { transform: "scale(2)", opacity: 0 },
});
registerKeyframes("pulse", {
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});
registerKeyframes("bounce", {
  "0%, 100%": {
    transform: "translateY(-25%)",
    "animation-timing-function": "cubic-bezier(0.8,0,1,1)",
  },
  "50%": {
    transform: "translateY(0)",
    "animation-timing-function": "cubic-bezier(0,0,0.2,1)",
  },
});

type AnimDirection = "normal" | "reverse" | "alternate" | "alternate-reverse";
type AnimFillMode = "none" | "forwards" | "backwards" | "both";

interface AnimationSpec {
  name: string;
  duration: number; // ms
  ease: (t: number) => number;
  delay: number; // ms
  iterations: number; // Infinity for "infinite"
  direction: AnimDirection;
  fillMode: AnimFillMode;
}

/** Parse the `animation` shorthand: `<name> <duration> [<easing>]
 *  [<delay>] [<iteration-count>] [<direction>] [<fill-mode>]`. Tokens
 *  after name+duration are order-independent (classified by shape, not
 *  position) — matches real CSS. `none` / empty / unparseable → null. */
export function parseAnimation(value: string): AnimationSpec | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none") return null;
  const toks = trimmed.split(/\s+/);
  const name = toks[0];
  if (!name) return null;
  let duration = 0;
  let easing = "ease";
  let delay = 0;
  let iterations = 1;
  let direction: AnimDirection = "normal";
  let fillMode: AnimFillMode = "none";
  let sawDuration = false;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === "infinite") { iterations = Infinity; continue; }
    if (t === "normal" || t === "reverse" || t === "alternate" || t === "alternate-reverse") {
      direction = t; continue;
    }
    if (t === "forwards" || t === "backwards" || t === "both") { fillMode = t; continue; }
    // Durations/delays REQUIRE a unit suffix — a bare number is an
    // iteration count instead (CSS has no unitless time value).
    if (t.endsWith("ms") || t.endsWith("s")) {
      const ms = parseDuration(t);
      if (!sawDuration) { duration = ms; sawDuration = true; } else { delay = ms; }
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(t)) { iterations = parseFloat(t); continue; }
    easing = t; // whatever's left: an easing keyword or cubic-bezier(...)
  }
  return { name, duration, ease: easeFromName(easing), delay, iterations, direction, fillMode };
}

interface ActiveAnimation {
  node: CmNode;
  spec: AnimationSpec;
  keyframes: KeyframeSet;
  start: number; // performance.now() at which the (post-delay) loop began
}

const lastAnimationValue = new Map<number, string>();
const activeAnimations = new Map<number, ActiveAnimation>();
let animRafId: number | null = null;

/** Parse one `transform` function-list into `{fn, value, unit}` triples
 *  — e.g. `"translateY(-25%) rotate(10deg)"` → two entries. Only single
 *  numeric-argument functions are understood (everything this file's
 *  own transform vocabulary — translate/rotate/scale — actually is);
 *  anything else is silently skipped, same "drop what we can't handle"
 *  policy the Rust `parse_transform` uses for skew/matrix/perspective. */
function parseTransformFns(s: string): Array<{ fn: string; value: number; unit: string }> {
  const out: Array<{ fn: string; value: number; unit: string }> = [];
  const re = /([a-zA-Z]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const arg = m[2].trim();
    const numMatch = /^(-?[\d.]+)([a-z%]*)$/.exec(arg);
    if (numMatch) {
      out.push({ fn: m[1], value: parseFloat(numMatch[1]), unit: numMatch[2] });
    }
  }
  return out;
}

/** Interpolate two `transform` strings at fraction `f`, function by
 *  function, when both sides use the exact same function list (order
 *  and names) — the case every one of this file's own keyframes (and
 *  the overwhelming majority of hand-authored ones) is in. Structurally
 *  different lists have nothing meaningful to lerp between, so this
 *  just snaps at the midpoint rather than guessing. */
function interpolateTransform(from: string, to: string, f: number): string {
  const a = parseTransformFns(from);
  const b = parseTransformFns(to);
  if (a.length === 0 || a.length !== b.length || a.some((x, i) => x.fn !== b[i].fn)) {
    return f < 0.5 ? from : to;
  }
  return a.map((x, i) => `${x.fn}(${x.value + (b[i].value - x.value) * f}${x.unit})`).join(" ");
}

/** Interpolate one prop's value between two keyframe stops. `transform`
 *  goes through `interpolateTransform`; colors and plain numerics reuse
 *  this file's own `parseColor`/`parseNumeric` (same as `transition`).
 *  Anything neither path can parse just snaps at the midpoint. */
function interpolateKeyframeValue(prop: string, from: any, to: any, f: number): string | number {
  if (prop === "transform") return interpolateTransform(String(from), String(to), f);
  if (COLOR_PROPS.has(prop)) {
    const c1 = parseColor(from);
    const c2 = parseColor(to);
    if (c1 && c2) {
      const r = c1[0] + (c2[0] - c1[0]) * f;
      const g = c1[1] + (c2[1] - c1[1]) * f;
      const b = c1[2] + (c2[2] - c1[2]) * f;
      const a = c1[3] + (c2[3] - c1[3]) * f;
      return formatColor(r, g, b, a);
    }
  }
  const n1 = parseNumeric(from);
  const n2 = parseNumeric(to);
  if (n1 != null && n2 != null) return n1 + (n2 - n1) * f;
  return f < 0.5 ? from : to;
}

/** Sample one prop's value at RAW (un-eased) fraction `t` (0..1) across
 *  a keyframe set — built ONLY from the stops that actually mention
 *  that prop (CSS keyframes don't require every stop to set every
 *  prop; this is the "build a per-prop timeline from whichever stops
 *  define it" simplification, which covers every one of this file's
 *  built-ins and any keyframe set that sets the same props at every
 *  stop — the common case). `null` if no stop defines the prop at all.
 *
 *  Takes RAW `t`, not pre-eased: the segment a given `t` falls into may
 *  carry its OWN `animation-timing-function` override (see
 *  `KeyframeStop.easing`), which has to warp just that segment's local
 *  fraction — warping the whole-animation `t` up front (like the
 *  `transition` tween loop does, having only one segment ever) would
 *  make a per-segment override impossible to apply correctly. Segments
 *  without an override fall back to `defaultEase` (the animation
 *  shorthand's own easing). */
function sampleKeyframeProp(
  keyframes: KeyframeSet,
  prop: string,
  t: number,
  defaultEase: (t: number) => number,
): string | number | null {
  const pts = keyframes.filter((k) => prop in k.props);
  if (pts.length === 0) return null;
  if (t <= pts[0].offset) return pts[0].props[prop];
  const last = pts[pts.length - 1];
  if (t >= last.offset) return last.props[prop];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t >= a.offset && t <= b.offset) {
      const span = Math.max(b.offset - a.offset, 1e-6);
      const localF = (t - a.offset) / span;
      const ease = a.easing ?? defaultEase;
      return interpolateKeyframeValue(prop, a.props[prop], b.props[prop], ease(localF));
    }
  }
  return last.props[prop];
}

function applyKeyframeAt(node: CmNode, keyframes: KeyframeSet, t: number, defaultEase: (t: number) => number) {
  const props = new Set<string>();
  for (const k of keyframes) for (const p of Object.keys(k.props)) props.add(p);
  for (const prop of props) {
    const v = sampleKeyframeProp(keyframes, prop, t, defaultEase);
    if (v != null) __cm_set_prop(node.id, prop, JSON.stringify(v));
  }
}

function ensureAnimLoop() {
  if (animRafId != null) return;
  animRafId = (globalThis as any).requestAnimationFrame(tickAnimations);
}

function tickAnimations(now: number) {
  animRafId = null;
  if (activeAnimations.size === 0) return;
  const finished: number[] = [];
  for (const [nodeId, anim] of activeAnimations) {
    const elapsed = now - anim.start;
    if (elapsed < 0) continue; // still in animation-delay
    const { spec, keyframes, node } = anim;
    const dur = Math.max(spec.duration, 1);
    const rawIter = elapsed / dur;
    let iterIndex = Math.floor(rawIter);
    let atEnd = false;
    if (spec.iterations !== Infinity && iterIndex >= spec.iterations) {
      iterIndex = Math.max(spec.iterations - 1, 0);
      atEnd = true;
    }
    let localT = atEnd ? 1 : rawIter - iterIndex;
    let reversed = spec.direction === "reverse";
    if (spec.direction === "alternate") reversed = iterIndex % 2 === 1;
    if (spec.direction === "alternate-reverse") reversed = iterIndex % 2 === 0;
    if (reversed) localT = 1 - localT;
    applyKeyframeAt(node, keyframes, localT, spec.ease);
    if (atEnd) finished.push(nodeId);
  }
  for (const id of finished) activeAnimations.delete(id);
  if (activeAnimations.size > 0) ensureAnimLoop();
  __cm_request_paint();
}

/** Hook for the `animation` style prop — mirrors `transition`'s
 *  `maybeStartTransition`/`parseTransition` pair but as one call, since
 *  there's no "changed FROM a previous value" to react to; only "is
 *  this a different animation than what's already configured" (a
 *  same-value re-set — e.g. React re-rendering a node whose `style`
 *  object is reconstructed every render — must NOT restart the loop
 *  from frame 0, so this compares against the raw string, not object
 *  identity). Call this INSTEAD OF forwarding `animation` through the
 *  generic `__cm_set_prop` path — the engine has no `animation` prop
 *  of its own; this file is the entire implementation. */
export function setAnimation(node: CmNode, value: string): void {
  const raw = value == null ? "" : String(value);
  if (lastAnimationValue.get(node.id) === raw) return;
  lastAnimationValue.set(node.id, raw);
  const spec = parseAnimation(raw);
  if (!spec) {
    activeAnimations.delete(node.id);
    return;
  }
  const keyframes = keyframeRegistry.get(spec.name);
  if (!keyframes || keyframes.length === 0) {
    activeAnimations.delete(node.id);
    return;
  }
  activeAnimations.set(node.id, { node, spec, keyframes, start: performance.now() + spec.delay });
  ensureAnimLoop();
}
