// CSS custom properties (`--name`) + `var()`.
//
// The build-time half of "CSS variables" already exists and is a SEPARATE
// concern: `theme-extractor.ts` parses `:root { --primary: ...; }` out of
// the app's globals.css at BUILD time, and the Tailwind class resolver
// bakes the resolved value directly into whatever utility class used it
// (`bg-primary` becomes `{background: "#0f172a"}` in the emitted bundle —
// no `var()` reference survives into what ships). That mechanism can't be
// reused here: it runs in the Vite plugin's Node.js build process, not in
// this renderer's runtime code (which executes inside the app, in QuickJS).
//
// What's missing — and what this file is — is RUNTIME custom properties:
// `style={{"--progress": "42%"}}` set dynamically (by a component, from
// state, computed at render time) and referenced elsewhere via
// `var(--progress[, fallback])`, resolved with real CSS scoping — nearest
// ancestor that defines the name wins, same as the DOM cascade.
//
// What's supported:
//   - Any style value containing `var(--name)` or `var(--name, fallback)`,
//     anywhere a string reaches `__cm_set_prop` through this renderer's
//     normal paths (inline `style`, class-derived styles, hover-variant
//     styles).
//   - Ancestor-chain lookup via `CmNode.parent` — a custom property
//     defined on any ancestor (or the element itself) is visible to the
//     whole subtree below it, until something closer overrides it.
//   - A `var()` inside a fallback resolving to another `var()` (a few
//     resolution passes, not just one).
//
// What's not:
//   - The build-time theme tokens (SHADCN_TOKENS) as a fallback source —
//     deliberately not wired in; see the module-load-context note above
//     for why that coupling doesn't make sense.
//   - `@property` typed custom properties / registration.
//   - Removing a custom property when its defining node unmounts (matches
//     this file's neighbors — `transitions.ts`'s per-node maps have the
//     same non-cleanup-on-unmount gap; not fixing that here either).

import "../host/imports.ts";
import type { CmNode } from "./node.ts";

const customProps = new Map<number, Map<string, string>>();

/** Record `--name: value` on `node`. Never forwarded to `__cm_set_prop`
 *  itself — the engine has no notion of custom properties; this map
 *  and `resolveCssVars` below are the entire implementation. */
export function setCustomProperty(node: CmNode, name: string, value: string): void {
  let m = customProps.get(node.id);
  if (!m) { m = new Map(); customProps.set(node.id, m); }
  m.set(name, value);
}

function lookupCustomProperty(node: CmNode | null, name: string): string | null {
  let cur: CmNode | null = node;
  while (cur) {
    const v = customProps.get(cur.id)?.get(name);
    if (v !== undefined) return v;
    cur = (cur.parent ?? null) as CmNode | null;
  }
  return null;
}

// `var(--name)` or `var(--name, fallback)`. The fallback branch allows
// one level of nested parens (`var(--a, rgba(0,0,0,.5))`) — CSS allows
// arbitrarily nested fallbacks; this covers the realistic cases without
// a real recursive-descent parser.
const VAR_RE = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;

/** Resolve every `var(--name[, fallback])` in `value` against `node`'s
 *  ancestor chain. Non-strings (and strings with no `var(`) pass through
 *  untouched — cheap early-out for the overwhelming majority of prop
 *  values, which are never custom-property references. An unresolved
 *  reference with no fallback is left as literal text rather than
 *  thrown on: the downstream Rust parser (color/length/etc.) will just
 *  fail to parse it and leave that prop unset, the same safe failure
 *  mode any other malformed value already gets. */
export function resolveCssVars(value: unknown, node: CmNode): unknown {
  if (typeof value !== "string" || !value.includes("var(")) return value;
  let out = value;
  // A few passes so a fallback that itself contains var(...) resolves
  // too, without looping forever on a value that never stops changing.
  for (let pass = 0; pass < 4 && out.includes("var("); pass++) {
    let changed = false;
    out = out.replace(VAR_RE, (whole, name: string, fallback: string | undefined) => {
      const resolved = lookupCustomProperty(node, name);
      if (resolved != null) { changed = true; return resolved; }
      if (fallback !== undefined) { changed = true; return fallback.trim(); }
      return whole;
    });
    if (!changed) break;
  }
  return out;
}

/** The common case: apply one style key/value pair to `node`, handling
 *  both directions of custom properties in one call — DEFINING one
 *  (`key` starts with `--`, stored and never forwarded) or CONSUMING
 *  one (any `var()` references in `value` resolved before it's sent
 *  on). Callers with special-case keys to intercept first (`transition`,
 *  `animation`, an active tween) should do that BEFORE reaching this —
 *  it's meant as the fallback tail of that chain, not a replacement
 *  for it. */
export function applySceneStyleProp(node: CmNode, key: string, value: unknown): void {
  if (value === undefined) return;
  if (key.startsWith("--")) {
    setCustomProperty(node, key, String(value));
    return;
  }
  const resolved = resolveCssVars(value, node);
  const json = JSON.stringify(resolved);
  if (typeof json !== "string") return;
  __cm_set_prop(node.id, key, json);
}
