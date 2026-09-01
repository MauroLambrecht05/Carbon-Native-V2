// Turning a React props bag into scene props.

import "../host/imports.ts";
import type { CmNode } from "./node.ts";
import {
  CLICKABLE_EVENTS,
  EVENT_PROP_TO_DOM,
  clickHandlers,
  eventHandlers,
  inputHandlers,
  type ClickEvent,
} from "./events.ts";
import { resolveNodeClassName } from "../styling/class-names.ts";
import { maybeStartTransition, parseTransition, recordAppliedValue, setAnimation, transitionConfig } from "./transitions.ts";
import { applySceneStyleProp } from "./css-vars.ts";

function isEventProp(name: string): boolean {
  return name.length > 2 && name[0] === "o" && name[1] === "n" && name[2] >= "A" && name[2] <= "Z";
}

// ─── Text-children collapsing ────────────────────────────────────────────
// `<text>foo {bar} baz</text>` produces children = ["foo ", bar, " baz"].
// If every child is string-like (string / number / null / undefined / bool),
// we want to render the WHOLE thing as a single carbon-mini text node — not
// as one outer node + N inline-text-instance siblings stacked vertically by
// the default flex-column direction. That stacking is exactly what made the
// metadata row read "Created" / "May 6, 2026" / "64 words" on separate
// lines and made tag chips break "#" / "welcome" onto two rows.
//
// shouldSetTextContent + the createInstance/commitUpdate branches in the
// HostConfig implement this: when a `<text>` sees only string-like children,
// we set the joined text on the SAME node and tell React not to create child
// text instances. Mixed children (e.g. `<text>foo <em>bar</em></text>`)
// fall back to the previous behaviour — but our scene graph doesn't have
// inline elements anyway, so that's a non-issue in practice.

function isStringLike(c: unknown): boolean {
  return c == null || typeof c === "string" || typeof c === "number" || typeof c === "boolean";
}

export function allStringLikeChildren(children: unknown): boolean {
  if (children == null) return true;
  if (isStringLike(children)) return true;
  if (Array.isArray(children)) return children.every(allStringLikeChildren);
  return false;
}

export function flattenStringChildren(children: unknown): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flattenStringChildren).join("");
  return "";
}

export function applyProps(node: CmNode, props: Record<string, unknown>): void {
  // Inline `style` is stashed and applied AFTER className resolution below.
  // Browser CSS specificity: an inline style always beats a class selector.
  // resolveNodeClassName() runs at the end (it needs the fully-accumulated
  // data-*/aria-* props to evaluate variants), and it applies class-derived
  // props via __cm_set_prop — so if we applied inline style during this loop,
  // a class like `px-1.5` would clobber a dynamic `style={{paddingLeft: N}}`.
  // That was the file-tree indentation bug: every row's depth padding got
  // overwritten by the row's `px-1.5` class. Defer style so it wins.
  let inlineStyle: Record<string, unknown> | null = null;
  // Rebuild this node's interaction-handler set from the current props so a
  // handler removed between renders doesn't linger (commitUpdate re-runs
  // applyProps wholesale). Cheap — most nodes carry none.
  eventHandlers.delete(node.id);
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === "children" || key === "key" || key === "ref") continue;

    // Click — wired to runtime's hit-test dispatcher.
    if (key === "onClick" || key === "onclick") {
      if (typeof v === "function") {
        clickHandlers.set(node.id, v as (e: ClickEvent) => void);
        __cm_set_prop(node.id, "clickable", "true");
      } else {
        clickHandlers.delete(node.id);
        __cm_set_prop(node.id, "clickable", "false");
      }
      continue;
    }

    // <input> / <textarea> change handler — wired to the runtime's
    // KeyboardInput → __cm_dispatch_input path. We accept either name
    // since React docs use both interchangeably for controlled inputs.
    if (key === "onChange" || key === "onInput") {
      if (typeof v === "function") {
        inputHandlers.set(node.id, v as (e: any) => void);
      } else {
        inputHandlers.delete(node.id);
      }
      continue;
    }

    // <input value="..."> — strip the JSON quotes so the runtime's
    // set_prop("value") receives a bare string. Without this special
    // case our generic `JSON.stringify(v)` path would emit `"\"hi\""`
    // and the input would display the literal quotes.
    if (key === "value" && (node.tag === "input" || node.tag === "textarea")) {
      __cm_set_prop(node.id, "value", JSON.stringify(String(v ?? "")));
      continue;
    }

    // Pointer / mouse / key / focus handlers → wired to the runtime's event
    // dispatch (see scene/events.ts) so Radix menus/selects/popovers and any
    // onPointerDown/onKeyDown-driven UI actually fire. Mark the node clickable
    // for press handlers so the hit-test can reach it.
    const domEventType = EVENT_PROP_TO_DOM[key];
    if (domEventType !== undefined) {
      if (typeof v === "function") {
        let m = eventHandlers.get(node.id);
        if (!m) { m = new Map(); eventHandlers.set(node.id, m); }
        m.set(domEventType, v as (e: any) => void);
        if (CLICKABLE_EVENTS.has(domEventType)) __cm_set_prop(node.id, "clickable", "true");
      }
      continue;
    }
    // Any other `on*` prop (onScroll, onWheel, onAnimationEnd, …) isn't
    // delivered by the runtime yet — skip silently rather than forwarding an
    // attribute the scene wouldn't understand.
    if (isEventProp(key)) continue;

    // style — stash now, apply after className resolution (see note above
    // for why inline style must win over class-derived props).
    if (key === "style" && v && typeof v === "object") {
      inlineStyle = v as Record<string, unknown>;
      continue;
    }

    // className handling is deferred to the end of applyProps so we have
    // already accumulated every other prop (data-state, aria-*, etc.)
    // and can evaluate conditional variants like `data-active:` against
    // them. Skip here; the post-loop block does the work.
    if (key === "className" || key === "class") continue;

    // Generic — resolve any `var(...)` references, then stringify and
    // forward. Skip undefined props (which `JSON.stringify` returns
    // `undefined` for, breaking the string-typed host import).
    if (v === undefined) continue;
    applySceneStyleProp(node, key, v);
  }

  // ── className resolution (last so we see every data-*, aria-* prop) ──
  // Stash the props bag on the node itself so descendants doing
  // group/peer-variant evaluation can walk back up and inspect this
  // node's `className` (for `group/NAME` markers) and other data-*
  // attributes. Cheap — same object React already holds.
  (node as unknown as { _props?: Record<string, unknown> })._props = props as Record<string, unknown>;

  resolveNodeClassName(node);

  // Apply inline style LAST so it overrides any class-derived prop of the
  // same name (correct CSS specificity: inline > class). React auto-appends
  // "px" to unitless numeric length values; the scene's parse_f32/parse_len
  // already treat a bare number (or "18") as px, so a plain JSON.stringify
  // of the number is sufficient here.
  if (inlineStyle) {
    for (const sk of Object.keys(inlineStyle)) {
      const sv = inlineStyle[sk];
      if (sv === undefined) continue;
      // `transition` configures future tweens on this node; it isn't
      // itself a paintable prop, so it never reaches __cm_set_prop.
      if (sk === "transition") {
        transitionConfig.set(node.id, parseTransition(String(sv)));
        continue;
      }
      // `animation` — same story, but setAnimation is the whole
      // start/restart/stop decision (see its own doc comment for why
      // this can't just be `maybeStartTransition`-shaped).
      if (sk === "animation") {
        setAnimation(node, String(sv));
        continue;
      }
      // `--name: value` — defines a custom property (never forwarded);
      // consuming a `var(...)` reference happens inside
      // `applySceneStyleProp` for every OTHER key below.
      if (sk.startsWith("--")) {
        applySceneStyleProp(node, sk, sv);
        continue;
      }
      // An animatable prop with an active transition spec tweens
      // instead of jumping straight to the new value.
      if (maybeStartTransition(node, sk, sv)) {
        recordAppliedValue(node.id, sk, sv);
        continue;
      }
      applySceneStyleProp(node, sk, sv);
      recordAppliedValue(node.id, sk, sv);
    }
  }

  __cm_request_paint();
}
