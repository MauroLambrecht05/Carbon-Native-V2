// Runtime className resolution.
//
// Static classNames are baked to inline styles by the babel pass at build
// time. What reaches here is the part that could not be: runtime-computed
// strings (cva / cn / clsx / conditional concat), and every conditional
// variant prefix — `hover:`, `data-active:`, `data-[state=open]:`,
// `group-data-X/NAME:`, `peer-data-X:`, `aria-[…]:` — which can only be
// evaluated against the props and the ancestry the element actually has.
//
// A separate module from scene/props.ts because this is where Tailwind's
// semantics live, and because it is the half a reader is most likely to be
// here to change.

import "../host/imports.ts";
import type { CmNode } from "../scene/node.ts";

/// Resolve a node's className string (read from node._props) into inline
/// scene styles. Called twice: first from applyProps (immediate), then
/// again from appendInitialChild/appendChild for each newly-inserted
/// node and its subtree — because the second pass runs once the node's
/// parent chain is set up, giving group-data/peer-data variants the
/// ancestor context they need to evaluate correctly.
export function resolveNodeClassName(node: CmNode): void {
  const np = (node as unknown as { _props?: Record<string, unknown> })._props;
  if (!np) return;
  const classProp = np.className ?? np.class;
  if (classProp === undefined || classProp === null) return;
  const classStr = String(classProp);
  const json = JSON.stringify(classStr);
  __cm_set_prop(node.id, "className", typeof json === "string" ? json : "\"\"");
  const resolve = (globalThis as unknown as { __cm_resolve_class?: (cls: string) => Record<string, unknown> | null }).__cm_resolve_class;
  if (!classStr || typeof resolve !== "function") return;
  for (const tok of classStr.split(/\s+/)) {
    if (!tok) continue;
    const split = splitVariantPrefix(tok);
    if (split) {
      // hover: variants — resolve the base class and apply each style
      // under the matching `*-hover` scene-prop name. The runtime's
      // hover hit-test (main.rs CursorMoved → hovered slot) already
      // swaps these in/out at paint time.
      if (split.variant === "hover" || split.variant === "focus" || split.variant === "focus-visible") {
        let hoverStyles: Record<string, unknown> | null = null;
        try { hoverStyles = resolve(split.base); } catch { /* unknown */ }
        if (!hoverStyles) continue;
        for (const sk of Object.keys(hoverStyles)) {
          const sv = hoverStyles[sk];
          if (sv === undefined) continue;
          const hoverKey = hoverPropKey(sk);
          const sjson = JSON.stringify(sv);
          if (typeof sjson !== "string") continue;
          __cm_set_prop(node.id, hoverKey, sjson);
        }
        continue;
      }
      if (!variantApplies(split.variant, np, node)) continue;
    }
    const baseClass = split ? split.base : tok;
    // If the base STILL has a `:` it means there was a nested variant
    // we peeled the outer one off but the inner is something we don't
    // recognize. Don't apply unconditionally.
    if (baseClass.includes(":")) continue;
    let styles: Record<string, unknown> | null = null;
    try { styles = resolve(baseClass); } catch { /* unknown — skip */ }
    if (!styles) continue;
    for (const sk of Object.keys(styles)) {
      const sv = styles[sk];
      if (sv === undefined) continue;
      const sjson = JSON.stringify(sv);
      if (typeof sjson !== "string") continue;
      __cm_set_prop(node.id, sk, sjson);
    }
  }
  // Re-apply inline style AFTER class-derived props so inline > class
  // specificity holds on EVERY resolve pass. This function runs twice for a
  // freshly-inserted node (applyProps, then reResolveSubtree on append); the
  // second pass re-ran className and used to clobber `style={{paddingLeft}}`
  // with e.g. `px-1.5` — which is exactly why an expanded folder's children
  // rendered un-indented until the next re-render corrected them.
  const inlineStyle = np.style as Record<string, unknown> | undefined;
  if (inlineStyle && typeof inlineStyle === "object") {
    for (const sk of Object.keys(inlineStyle)) {
      const sv = inlineStyle[sk];
      if (sv === undefined) continue;
      const sjson = JSON.stringify(sv);
      if (typeof sjson === "string") __cm_set_prop(node.id, sk, sjson);
    }
  }
}

/// Map a base scene-prop name to its hover-variant equivalent.
/// The scene currently models bg + color hover overrides; everything
/// else falls back to non-hover (no override on hover).
function hoverPropKey(baseKey: string): string {
  if (baseKey === "background") return "background-hover";
  if (baseKey === "color") return "color-hover";
  // Future hover-able props (border-color-hover, etc.) can be added
  // here as the scene grows support. For now, route unknowns to a
  // namespaced name the scene ignores — no-op rather than overwriting
  // the base.
  return `${baseKey}-hover`;
}

/// Walk a subtree resolving every descendant's className. Used by the
/// HostConfig insertion hooks so a deep child whose `group-data-X/NAME:`
/// variant needs a freshly-set ancestor in the parent chain gets a
/// chance to re-evaluate.
export function reResolveSubtree(node: CmNode): void {
  resolveNodeClassName(node);
  for (const c of node.children) reResolveSubtree(c);
}

// splitVariantPrefix — peel ONE leading variant off a class token, taking
// nested brackets into account so arbitrary selectors like
// `data-[state=open]:` are kept intact. Returns `{variant, base}` or null
// when the token has no variant prefix.
function splitVariantPrefix(tok: string): { variant: string; base: string } | null {
  let depth = 0;
  for (let i = 0; i < tok.length; i++) {
    const c = tok[i];
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0) {
      return { variant: tok.slice(0, i), base: tok.slice(i + 1) };
    }
  }
  return null;
}

// variantApplies — decide whether a given variant prefix (e.g. `hover`,
// `data-active`, `data-[state=open]`, `aria-[orientation=vertical]`)
// applies to an element with the supplied props.
//
// We support the subset that's static at render time:
//   • `data-active` / `data-state-active` etc. — true when the
//     corresponding `data-state` prop equals "active".
//   • `data-[name=value]` — true when `data-name` prop equals value
//     (case-insensitive). Bare `data-[name]` matches truthy.
//   • `aria-[name=value]` — same shape against aria-* props.
//   • Interaction states (`hover`, `focus`, etc.) — return false; we
//     don't have hover state in scene-graph mode yet.
//   • Anything we don't recognize — return false (conservative drop;
//     the static base styles still ship).
function variantApplies(variant: string, props: Record<string, unknown>, node?: CmNode): boolean {
  // hover/focus/active/disabled — runtime interaction we don't track yet.
  if (/^(hover|focus|focus-visible|focus-within|active|disabled|visited|checked|placeholder|first|last|odd|even|group-hover|group-focus|peer-hover|peer-focus|peer-checked)$/.test(variant)) {
    return false;
  }
  // dark/light/sm/md/lg/etc — already handled by stripVariants at build
  // time for static classes; for runtime tokens with these prefixes we
  // apply them (terax-ai is light-themed; matchMedia returns no match).
  if (/^(dark|light|sm|md|lg|xl|2xl|portrait|landscape|motion-safe|motion-reduce|print|rtl|ltr)$/.test(variant)) {
    return true;
  }
  // Bracketed arbitrary attribute selector: `data-[state=open]`,
  // `aria-[orientation=vertical]`, etc.
  const bracket = variant.match(/^(data|aria)-\[([^\]=]+)(?:=([^\]]+))?\]$/);
  if (bracket) {
    const prefix = bracket[1];
    const name = bracket[2];
    const expected = bracket[3];
    const propKey = `${prefix}-${name}`;
    const val = (props as Record<string, unknown>)[propKey];
    if (expected === undefined) return val != null && val !== false && val !== "";
    return String(val) === expected;
  }
  // Short data state form Tailwind v4 ships: `data-active`,
  // `data-checked`, etc. Maps to `data-state` prop having that value.
  const dataShort = variant.match(/^data-([a-z][a-z0-9-]*)$/);
  if (dataShort) {
    return matchDataShort(dataShort[1], props);
  }
  // Group-data variants: `group-data-X/NAME` applies when an ancestor
  // marked with `group/NAME` (or `group` for the unnamed group) carries
  // a matching data-state attribute. `group-data-[state=open]/NAME`
  // accepts the bracketed form too.
  //
  // Walking parents requires a real node; if applyProps didn't pass
  // one in we conservatively drop the token.
  const groupData = variant.match(/^group-data-(.+?)(?:\/([a-zA-Z0-9_-]+))?$/);
  if (groupData && node) {
    const inner = groupData[1];
    const groupName = groupData[2]; // undefined → unnamed `group`
    const ancestor = findGroupAncestor(node, groupName);
    if (!ancestor) return false;
    const ancestorProps = (ancestor as unknown as { _props?: Record<string, unknown> })._props ?? {};
    // Recurse with the ancestor's props — the inner selector evaluates
    // against the ANCESTOR'S data-* attrs, not the descendant's.
    return innerDataVariant(inner, ancestorProps);
  }
  const groupAria = variant.match(/^group-aria-(.+?)(?:\/([a-zA-Z0-9_-]+))?$/);
  if (groupAria && node) {
    const inner = groupAria[1];
    const groupName = groupAria[2];
    const ancestor = findGroupAncestor(node, groupName);
    if (!ancestor) return false;
    const ancestorProps = (ancestor as unknown as { _props?: Record<string, unknown> })._props ?? {};
    return innerAriaVariant(inner, ancestorProps);
  }
  // peer-data: same shape but looks at the previous sibling rather than
  // ancestors. We approximate by walking parent.children for a peer
  // marked `peer/NAME`.
  const peerData = variant.match(/^peer-data-(.+?)(?:\/([a-zA-Z0-9_-]+))?$/);
  if (peerData && node) {
    const inner = peerData[1];
    const peerName = peerData[2];
    const peer = findPeer(node, peerName);
    if (!peer) return false;
    const peerProps = (peer as unknown as { _props?: Record<string, unknown> })._props ?? {};
    return innerDataVariant(inner, peerProps);
  }
  // has-data variants: applies when this node has a descendant matching.
  // Approximate by checking direct children only — recursive scan is too
  // expensive for every className.
  const hasData = variant.match(/^has-data-\[([^\]=]+)(?:=([^\]]+))?\]$/);
  if (hasData && node) {
    const name = hasData[1];
    const expected = hasData[2];
    for (const c of node.children) {
      const cp = (c as unknown as { _props?: Record<string, unknown> })._props ?? {};
      const val = cp[`data-${name}`];
      if (val !== undefined) {
        if (expected === undefined) return val != null && val !== false && val !== "";
        if (String(val) === expected) return true;
      }
    }
    return false;
  }
  // Pseudo-element / pseudo-class variants we don't model (before, after,
  // placeholder, …) — drop. Their styles live in shadow-of-shadow CSS
  // that doesn't interact with carbon-mini's paint model.
  return false;
}

function innerDataVariant(inner: string, props: Record<string, unknown>): boolean {
  // Bracketed form: `[state=open]` / `[state]`
  const bracket = inner.match(/^\[([^\]=]+)(?:=([^\]]+))?\]$/);
  if (bracket) {
    const name = bracket[1];
    const expected = bracket[2];
    const val = (props as Record<string, unknown>)[`data-${name}`];
    if (expected === undefined) return val != null && val !== false && val !== "";
    return String(val) === expected;
  }
  // Short form: `horizontal` / `active` (matches data-state value)
  return matchDataShort(inner, props);
}

function innerAriaVariant(inner: string, props: Record<string, unknown>): boolean {
  const bracket = inner.match(/^\[([^\]=]+)(?:=([^\]]+))?\]$/);
  if (bracket) {
    const name = bracket[1];
    const expected = bracket[2];
    const val = (props as Record<string, unknown>)[`aria-${name}`];
    if (expected === undefined) return val != null && val !== false && val !== "";
    return String(val) === expected;
  }
  const val = (props as Record<string, unknown>)[`aria-${inner}`];
  return val != null && val !== false && val !== "";
}

function matchDataShort(name: string, props: Record<string, unknown>): boolean {
  const dataState = (props as Record<string, unknown>)["data-state"];
  if (dataState !== undefined) return String(dataState) === name;
  // Also recognized: data-orientation when the variant name is a known
  // orientation value. Lets `group-data-horizontal/tabs:` match an
  // ancestor with `data-orientation=horizontal`.
  if (name === "horizontal" || name === "vertical") {
    const orient = (props as Record<string, unknown>)["data-orientation"];
    if (orient !== undefined) return String(orient) === name;
  }
  // Fallback: a bare `data-NAME` prop with a truthy value.
  const direct = (props as Record<string, unknown>)[`data-${name}`];
  return direct != null && direct !== false && direct !== "";
}

// findGroupAncestor — walk up `node.parent` looking for an ancestor whose
// className contains `group/NAME` (or `group` if name is undefined).
function findGroupAncestor(node: CmNode, name: string | undefined): CmNode | null {
  let cur: CmNode | null = (node.parent ?? null) as CmNode | null;
  const target = name ? `group/${name}` : null;
  while (cur) {
    const p = (cur as unknown as { _props?: Record<string, unknown> })._props;
    const cls = p ? String(p.className ?? p.class ?? "") : "";
    if (cls) {
      // Word-boundary check — `group-foo` shouldn't match `group`.
      const tokens = cls.split(/\s+/);
      for (const tok of tokens) {
        if (target && tok === target) return cur;
        if (!target && tok === "group") return cur;
      }
    }
    cur = (cur.parent ?? null) as CmNode | null;
  }
  return null;
}

// findPeer — look for a sibling marked `peer/NAME` (or `peer`). Returns
// the first matching sibling earlier in the parent's children list, OR
// any peer if order doesn't matter.
function findPeer(node: CmNode, name: string | undefined): CmNode | null {
  const parent = node.parent;
  if (!parent) return null;
  const target = name ? `peer/${name}` : null;
  for (const sib of parent.children) {
    if (sib === node) continue;
    const p = (sib as unknown as { _props?: Record<string, unknown> })._props;
    const cls = p ? String(p.className ?? p.class ?? "") : "";
    if (!cls) continue;
    const tokens = cls.split(/\s+/);
    for (const tok of tokens) {
      if (target && tok === target) return sib;
      if (!target && tok === "peer") return sib;
    }
  }
  return null;
}
