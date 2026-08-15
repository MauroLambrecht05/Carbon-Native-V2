// CSS transitions.

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
//   - cubic-bezier(...) easing curves
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

function easeFromName(name: string): (t: number) => number {
  switch (name) {
    case "linear": return (t) => t;
    case "ease-in": return (t) => t * t;
    case "ease-out": return (t) => 1 - (1 - t) * (1 - t);
    case "ease-in-out":
      return (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    case "ease":
    default:
      // Approximate CSS `ease`: cubic-bezier(0.25, 0.1, 0.25, 1.0)
      return (t) => 1 - Math.pow(1 - t, 3);
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
