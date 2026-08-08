// @carbon/mini-react — React 18+ on top of carbon-mini's scene-graph host
// imports. Implements the react-reconciler HostConfig directly; never
// imports react-dom; never touches a DOM API. Each React fiber commits to
// a CmNode that calls into the runtime's __cm_* host imports.
//
//   import { render } from "@carbon/mini-react";
//   render(<App />);            // mounts under the runtime's root view
//
// Carbon-mini's scene-graph contract (the bound globals declared below)
// is identical to what carbon/runtime/engine/paint/renderers/solid uses for Solid; the two
// adapters can coexist in the same JS context if needed.

import ReactReconciler from "react-reconciler";
import {
  ConcurrentRoot,
  LegacyRoot,
  DefaultEventPriority,
} from "react-reconciler/constants";

// ─── Host imports declared by carbon/runtime/mini.rs ──────────────────
declare const __cm_create_node: (id: number, tag: string, propsJson: string) => void;
declare const __cm_set_text: (id: number, text: string) => void;
declare const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
declare const __cm_insert_node: (parentId: number, childId: number, beforeId: number) => void;
declare const __cm_remove_node: (id: number) => void;
declare const __cm_set_root: (id: number) => void;
declare const __cm_request_paint: () => void;

// ─── Universal dispatcher flushSync wrapper ──────────────────────────────
//
// The runtime calls `globalThis.__cm_dispatch_*(...)` from QuickJS-eval
// (outside React's event system). React's batched-updates machinery
// doesn't notice these calls, so a plain `setState(...)` inside a
// dispatcher handler is silently dropped — the render never commits, the
// useEffect never fires, the menu/tab/whatever never appears.
//
// We install accessor traps for every dispatcher name on globalThis so
// that *whichever package* assigns a handler — @carbon/compat-dom, the
// Solid mini-runtime, app code — the stored function is transparently
// wrapped in `reconciler.flushSync(...)` + a paint request. By the time
// any dispatcher actually fires the reconciler is initialised, so the
// wrapper just looks it up lazily.
//
// Wrapping is idempotent (we tag with __cmFlushWrapped so re-assignments
// don't pile up wrappers), and the setter trap catches future assignments
// — so order-of-import between this module, @carbon/compat-dom, and
// mini-runtime no longer matters.
//
// Names matched: anything starting with `__cm_dispatch_`, `__cm_*_dispatch_*`,
// or `__cm_window_dispatch_*` — i.e. the entire Rust→JS event surface.
const FLUSH_DISPATCHER_KEYS = [
  "__cm_dispatch_click",
  "__cm_dispatch_input",
  "__cm_dispatch_keydown",
  "__cm_dispatch_context_menu",
  "__cm_dispatch_pointer",
  "__cm_dispatch_file_drag",
  "__cm_dispatch_theme_changed",
  "__cm_dispatch_window_focus",
  "__cm_window_dispatch_resize",
  "__cm_pty_dispatch_output",
  "__cm_pty_dispatch_exit",
  "__cm_fetch_dispatch_headers",
  "__cm_fetch_dispatch_chunk",
  "__cm_fetch_dispatch_end",
  "__cm_fetch_dispatch_error",
  "__cm_ws_dispatch_open",
  "__cm_ws_dispatch_message",
  "__cm_ws_dispatch_close",
  "__cm_ws_dispatch_error",
];

/** Resolve the reconciler's synchronous-flush method across react-
 *  reconciler versions. 0.29 (React 18) exposed it as `flushSync`;
 *  0.31 (React 19) renamed to `flushSyncFromReconciler`. Both signatures
 *  are `(fn) => void`. */
function resolveFlushSync(): ((cb: () => void) => void) | null {
  const r = reconciler as unknown as {
    flushSyncFromReconciler?: (cb: () => void) => void;
    flushSync?: (cb: () => void) => void;
  } | undefined;
  return r?.flushSyncFromReconciler ?? r?.flushSync ?? null;
}

function wrapDispatcherInFlushSync(fn: unknown): unknown {
  if (typeof fn !== "function") return fn;
  // Avoid re-wrapping when a dispatcher is chained (`prev?.()`) — that
  // would compound flushSync calls on every reassignment.
  if ((fn as { __cmFlushWrapped?: boolean }).__cmFlushWrapped) return fn;
  const wrapped: any = (...args: unknown[]) => {
    // `reconciler` is defined later in this file; by the time any
    // dispatcher actually fires, the module has finished initialising.
    const sync = resolveFlushSync();
    if (sync) {
      sync(() => {
        (fn as (...a: unknown[]) => void)(...args);
      });
      __cm_request_paint();
    } else {
      // Pre-reconciler-init path: just invoke. Anything called this
      // early can't depend on React state.
      (fn as (...a: unknown[]) => void)(...args);
    }
  };
  (wrapped as { __cmFlushWrapped: boolean }).__cmFlushWrapped = true;
  return wrapped;
}

{
  const g = globalThis as Record<string, unknown>;
  const storage: Record<string, unknown> = {};
  const installTrap = (key: string) => {
    storage[key] = wrapDispatcherInFlushSync(g[key]);
    try {
      Object.defineProperty(g, key, {
        configurable: true,
        enumerable: true,
        get() { return storage[key]; },
        set(v) { storage[key] = wrapDispatcherInFlushSync(v); },
      });
    } catch {
      // If a non-configurable property already exists (shouldn't, but
      // defensive), fall back to a direct overwrite.
      g[key] = storage[key];
    }
  };
  for (const k of FLUSH_DISPATCHER_KEYS) installTrap(k);
}

// ─── Scene node — what a fiber commits to ─────────────────────────────────
export interface CmNode {
  id: number;
  tag: string;
  isText: boolean;
  parent: CmNode | null;
  children: CmNode[];
}

// Shared, process-wide node-id allocator — see the long note in
// @carbon/compat-dom/src/node.ts. Every adapter that emits scene nodes must
// draw ids from this single globalThis counter, or co-resident adapters
// (e.g. this reconciler + the DOM shim that backs xterm/Radix) collide and
// overwrite each other's nodes in the shared Rust scene map.
function nextNodeId(): number {
  const g = globalThis as { __cm_node_id_seq?: number };
  const next = (typeof g.__cm_node_id_seq === "number" ? g.__cm_node_id_seq : 99) + 1;
  g.__cm_node_id_seq = next;
  return next;
}
const clickHandlers = new Map<number, (e: ClickEvent) => void>();
const inputHandlers = new Map<number, (e: any) => void>();
const nodeTexts = new Map<number, string>();

// Pointer / mouse / key / focus handlers wired from React `on*` props,
// keyed by scene-node id → DOM event type → handler. Radix (menus, selects,
// popovers, tooltips) opens its triggers on `onPointerDown` / `onKeyDown`,
// never `onClick`; before this those props were silently dropped by
// applyProps, so every dropdown was dead. The `__cm_dispatch_pointer`
// override installed below fires these for React host nodes.
const eventHandlers = new Map<number, Map<string, (e: any) => void>>();
// id → CmNode, so a dispatched synthetic event can carry the real node as
// its target/currentTarget and so the dispatcher can tell a React host node
// from a @carbon/compat-dom node (which the DOM-shim dispatcher owns).
const nodeRegistry = new Map<number, CmNode>();

// React `on*` prop → DOM event type. Only the interaction events the runtime
// actually delivers are wired; anything else (onScroll, onWheel,
// onAnimationEnd, …) still no-ops as before.
const EVENT_PROP_TO_DOM: Record<string, string> = {
  onPointerDown: "pointerdown", onPointerUp: "pointerup", onPointerMove: "pointermove",
  onPointerEnter: "pointerenter", onPointerLeave: "pointerleave",
  onPointerOver: "pointerover", onPointerOut: "pointerout", onPointerCancel: "pointercancel",
  onMouseDown: "mousedown", onMouseUp: "mouseup", onMouseMove: "mousemove",
  onMouseEnter: "mouseenter", onMouseLeave: "mouseleave",
  onKeyDown: "keydown", onKeyUp: "keyup",
  onFocus: "focus", onBlur: "blur", onContextMenu: "contextmenu",
};
// Wiring any of these implies the node must be hit-testable — the runtime
// only dispatches pointer/click to `clickable` nodes, and a Radix trigger is
// often a bare <span> with just onPointerDown (the cwd-breadcrumb dropdown),
// which would otherwise never receive the press.
const CLICKABLE_EVENTS = new Set(["pointerdown", "pointerup", "mousedown", "mouseup"]);

export interface ClickEvent {
  id: number;
}

// Rust hit-test path → eval → this dispatcher → React click handler.
// The setter trap above wraps the function we assign here in
// `flushSync` + `__cm_request_paint()`, so we just invoke the handler
// — committed state and paint both happen automatically.
(globalThis as any).__cm_dispatch_click = (id: number) => {
  clickHandlers.get(id)?.({ id });
};

// Rust input-edit path → eval → this dispatcher → React onChange. Builds
// the React-shaped synthetic event so user code can write the standard
// `onChange={(e) => setX(e.target.value)}` pattern. The trap handles
// the flushSync/paint pairing.
(globalThis as any).__cm_dispatch_input = (id: number, value: string) => {
  const handler = inputHandlers.get(id);
  if (!handler) return;
  const syntheticTarget = { value, name: "", id: String(id) };
  const event = {
    target: syntheticTarget,
    currentTarget: syntheticTarget,
    type: "change",
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { (event as { defaultPrevented: boolean }).defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
    persist() {},
    nativeEvent: { value },
  };
  handler(event);
};

// Pointer/mouse event bridge for React host nodes. @carbon/compat-dom installs
// a `__cm_dispatch_pointer` that only knows its own DOM-shim nodes (xterm,
// portal targets); React CmNodes aren't in that registry, so a Radix
// trigger's `onPointerDown` was never delivered and menus/selects/popovers
// never opened. We install a dispatcher that fires the React-prop handlers
// for our nodes and chains to the previous one for everything else. The
// dispatcher trap above wraps this in flushSync so state set inside a
// handler (e.g. Radix's onOpenToggle) commits + paints synchronously.
{
  const g = globalThis as any;
  const prevDispatchPointer = g.__cm_dispatch_pointer;
  const makePointerEvent = (
    type: string, node: CmNode | null, x: number, y: number, button: number,
  ) => {
    const ev: any = {
      type, target: node, currentTarget: node,
      button: button | 0, buttons: type.endsWith("down") ? 1 : 0,
      clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
      movementX: 0, movementY: 0,
      // Radix's DropdownMenuTrigger opens only when `button === 0 &&
      // ctrlKey === false`, so these must be present and falsy.
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1,
      pressure: type.endsWith("down") ? 0.5 : 0,
      bubbles: true, cancelable: true, defaultPrevented: false, isTrusted: true,
      eventPhase: 2,
      preventDefault() { ev.defaultPrevented = true; },
      stopPropagation() {}, stopImmediatePropagation() {}, persist() {},
      composedPath() { return node ? [node] : []; },
      nativeEvent: null as any,
    };
    ev.nativeEvent = ev;
    return ev;
  };
  g.__cm_dispatch_pointer = (
    cmId: number, phase: string, x: number, y: number, button: number,
  ) => {
    const handlers = eventHandlers.get(cmId);
    if (handlers) {
      const node = nodeRegistry.get(cmId) ?? null;
      const types = phase === "down" ? ["pointerdown", "mousedown"]
        : phase === "up" ? ["pointerup", "mouseup"]
        : phase === "move" ? ["pointermove", "mousemove"]
        : [];
      for (const t of types) {
        const fn = handlers.get(t);
        if (typeof fn !== "function") continue;
        try { fn(makePointerEvent(t, node, x, y, button)); }
        catch (e) { (globalThis as any).console?.error?.("[react-mini] pointer handler threw:", e); }
      }
    }
    // Chain to the DOM-shim dispatcher so its own nodes (xterm focus, portal
    // refs) still receive the press. No-ops for React ids it doesn't know.
    if (typeof prevDispatchPointer === "function") {
      try { prevDispatchPointer(cmId, phase, x, y, button); } catch { /* ignore */ }
    }
  };
}

/**
 * Resolve a node's *scene* id. React host nodes (CmNode) carry a numeric
 * `.id`; @carbon/compat-dom nodes (e.g. `document.body`, a Radix portal target)
 * carry `.cmId` and use `.id` for the HTML id attribute (a string). The
 * reconciler's container ops can receive EITHER (portals mount into
 * document.body), so passing `.id` blindly hands the runtime a string where it
 * wants an f64 ("Error converting from js 'string' into type 'f64'"). Always
 * go through this so the right numeric scene id reaches `__cm_insert_node`.
 */
function sceneIdOf(n: any): number {
  if (n && typeof n.cmId === "number") return n.cmId;
  if (n && typeof n.id === "number") return n.id;
  return getRoot().id;
}

function freshNode(tag: string | undefined | null, isText = false): CmNode {
  const id = nextNodeId();
  // Tag may arrive undefined for fragment-like / unknown elements.
  // Default to "view" so we still emit a scene node — better than
  // throwing and crashing the whole render tree.
  const safeTag = typeof tag === "string" && tag ? tag : "view";
  __cm_create_node(id, safeTag, "{}");
  const node: CmNode = { id, tag: safeTag, isText, parent: null, children: [] };
  nodeRegistry.set(id, node);
  return node;
}

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
// shouldSetTextContent + the createInstance/commitUpdate branches below
// implement this: when a `<text>` sees only string-like children, we set
// the joined text on the SAME node and tell React not to create child
// text instances. Mixed children (e.g. `<text>foo <em>bar</em></text>`)
// fall back to the previous behaviour — but our scene graph doesn't have
// inline elements anyway, so that's a non-issue in practice.

function isStringLike(c: unknown): boolean {
  return c == null || typeof c === "string" || typeof c === "number" || typeof c === "boolean";
}

function allStringLikeChildren(children: unknown): boolean {
  if (children == null) return true;
  if (isStringLike(children)) return true;
  if (Array.isArray(children)) return children.every(allStringLikeChildren);
  return false;
}

function flattenStringChildren(children: unknown): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flattenStringChildren).join("");
  return "";
}

function applyProps(node: CmNode, props: Record<string, unknown>): void {
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
    // dispatch (see __cm_dispatch_pointer above) so Radix menus/selects/
    // popovers and any onPointerDown/onKeyDown-driven UI actually fire. Mark
    // the node clickable for press handlers so the hit-test can reach it.
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

    // Generic — stringify and forward. Skip undefined props (which
    // `JSON.stringify` returns `undefined` for, breaking the
    // string-typed host import).
    if (v === undefined) continue;
    const json = JSON.stringify(v);
    if (typeof json !== "string") continue;
    __cm_set_prop(node.id, key, json);
  }

  // ── className resolution (last so we see every data-*, aria-* prop) ──
  // Static classNames are baked to inline styles by the babel pass at
  // build time. Runtime-computed strings (cva/cn/clsx/conditional concat)
  // reach us here. We split into tokens, evaluate any conditional
  // variant prefix (`hover:`, `data-active:`, `data-[state=open]:`,
  // `aria-[orientation=vertical]:`, etc.) against the element's other
  // props, then resolve the base class through __cm_resolve_class and
  // apply the resulting inline styles.
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
      const json = JSON.stringify(sv);
      if (typeof json !== "string") continue;
      __cm_set_prop(node.id, sk, json);
    }
  }

  __cm_request_paint();
}

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
function reResolveSubtree(node: CmNode): void {
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

// ─── HostConfig ───────────────────────────────────────────────────────────
// The minimum surface for a mutation-mode reconciler. ~30 methods total;
// the bulk are stubs because we don't use Suspense, hydration, scopes,
// activity, or persistence.

const hostConfig: any = {
  // Required capability flags
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  warnsIfNotActing: false,
  supportsMicrotasks: true,

  // ── Construction ──────────────────────────────────────────────────────
  createInstance(type: string, props: Record<string, unknown>): CmNode {
    const node = freshNode(type, false);
    // For `<text>` with all-string-like children, set the joined text on
    // this node directly. Pairs with shouldSetTextContent below — React
    // won't create text-instance children when that returns true, so the
    // single set_text call is the whole story.
    if (type === "text" && allStringLikeChildren(props.children)) {
      const s = flattenStringChildren(props.children);
      __cm_set_text(node.id, s);
      nodeTexts.set(node.id, s);
    }
    // Defensive applyProps: a broken prop value (undefined where
    // string expected, or a non-stringifiable cycle) should NOT crash
    // the whole render tree. Log + continue.
    try {
      applyProps(node, props);
    } catch (e: any) {
      (globalThis as any).console?.warn?.(
        `[@carbon/mini-react] applyProps failed for <${type}>:`,
        e?.message ?? String(e),
      );
    }
    // Mimic DOM-shaped surface enough that libraries reaching for
    // `.ownerDocument` / `.parentNode` don't crash. These don't make
    // the node behave like a DOM node — they just stop the most
    // common crashes during Radix / shadcn render walks.
    (node as any).ownerDocument = (globalThis as any).document;
    (node as any).nodeType = 1; // ELEMENT_NODE
    (node as any).tagName = (type || "").toUpperCase();
    (node as any).nodeName = (node as any).tagName;
    // Reactive `style` — framer-motion animates by writing `element.style.*`
    // imperatively every frame (outside React). A dead `{}` swallowed those
    // writes, so motion elements froze at their `initial` value (e.g. the AI
    // button stuck at `y:-15`). This proxy forwards each style write to the
    // scene so the animation actually renders and settles at its target.
    {
      const nodeId = node.id;
      const store: Record<string, string> = {};
      const push = (prop: string, value: unknown) => {
        const k = String(prop);
        if (k.startsWith("_") || k === "cssText") return;
        // React style keys are camelCase; scene set_prop matches camelCase +
        // kebab, so forward as-is. Skip removes with empty string.
        store[k] = value == null ? "" : String(value);
        try { __cm_set_prop(nodeId, k, JSON.stringify(store[k])); } catch { /* unknown prop */ }
        try { __cm_request_paint(); } catch { /* pre-paint */ }
      };
      (node as any).style = new Proxy(store, {
        get(t, prop: string) {
          if (prop === "setProperty") return (k: string, v: unknown) => push(k, v);
          if (prop === "removeProperty") return (k: string) => { const old = t[k]; push(k, ""); delete t[k]; return old ?? ""; };
          if (prop === "getPropertyValue") return (k: string) => t[k] ?? "";
          if (prop === "getPropertyPriority") return () => "";
          if (prop === "item") return (i: number) => Object.keys(t)[i] ?? "";
          if (prop === "cssText") return Object.entries(t).map(([k, v]) => `${k}:${v}`).join(";");
          if (prop === "length") return Object.keys(t).length;
          return t[prop];
        },
        set(t, prop: string, value) {
          push(prop, value);
          return true;
        },
      });
    }
    (node as any).dataset = {};
    (node as any).classList = {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
      replace() {}, item() { return null; }, get length() { return 0; },
    };
    (node as any).getAttribute = () => null;
    (node as any).setAttribute = () => {};
    (node as any).removeAttribute = () => {};
    (node as any).hasAttribute = () => false;
    // Minimal real event system on the host node. Libraries (Radix focus-scope
    // / dismissable-layer) add listeners to a ref then dispatch their own
    // CustomEvents and branch on `defaultPrevented`. A no-op addEventListener +
    // missing dispatchEvent meant `ref.dispatchEvent(...)` threw "not a
    // function" mid-mount. We store listeners and invoke them on dispatch so
    // that programmatic dispatch round-trips correctly.
    const _listeners = new Map<string, Set<(e: any) => void>>();
    (node as any).addEventListener = (type: string, fn: (e: any) => void) => {
      if (typeof fn !== "function") return;
      let set = _listeners.get(type);
      if (!set) { set = new Set(); _listeners.set(type, set); }
      set.add(fn);
    };
    (node as any).removeEventListener = (type: string, fn: (e: any) => void) => {
      _listeners.get(type)?.delete(fn);
    };
    (node as any).dispatchEvent = (evt: any): boolean => {
      if (!evt) return true;
      try { if (evt.target == null) evt.target = node; } catch { /* read-only */ }
      try { if (evt.currentTarget == null) evt.currentTarget = node; } catch { /* read-only */ }
      const set = _listeners.get(evt?.type);
      if (set) for (const fn of [...set]) { try { fn.call(node, evt); } catch { /* swallow */ } }
      return !(evt && evt.defaultPrevented);
    };
    (node as any).contains = (other: any) => {
      let cur: any = other;
      while (cur) { if (cur === node) return true; cur = cur.parent; }
      return false;
    };
    // Web Animations API + pointer capture — Radix and Framer Motion probe
    // these on refs during open/close transitions and press interactions.
    // A missing method throws "TypeError: not a function" mid-render and
    // (without an error boundary) blanks the tree. We implement no-op-but-
    // shaped versions so the call sites round-trip:
    //   • getAnimations() → [] (no running CSS/WAAPI animations, so Radix's
    //     Presence unmounts immediately instead of waiting for a fake one).
    //   • animate() → a resolved-Animation stub so `.animate(...).finished`
    //     and `.cancel()` work.
    //   • hasPointerCapture()/set/release — Radix Slider/Switch/Toggle call
    //     these off pointer events; false + no-op is the correct inert answer.
    (node as any).getAnimations = () => [];
    (node as any).animate = (keyframes: any, _options?: any) => {
      // We don't run timed animations; settle at the END state so motion
      // elements render at rest (WAAPI path). Framer passes either
      // [{transform:'a'},{transform:'b'}] or {transform:['a','b'], opacity:[..]}.
      try {
        const st = (node as any).style;
        const last: Record<string, unknown> = {};
        if (Array.isArray(keyframes)) {
          Object.assign(last, keyframes[keyframes.length - 1] ?? {});
        } else if (keyframes && typeof keyframes === "object") {
          for (const k of Object.keys(keyframes)) {
            const v = (keyframes as any)[k];
            last[k] = Array.isArray(v) ? v[v.length - 1] : v;
          }
        }
        for (const k of Object.keys(last)) {
          if (k === "offset" || k === "easing" || k === "composite") continue;
          try { st[k] = last[k]; } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      const noop = () => {};
      return {
        finished: Promise.resolve(),
        commitStyles: noop, persist: noop,
        cancel: noop, finish: noop, play: noop, pause: noop, reverse: noop,
        addEventListener: noop, removeEventListener: noop,
        onfinish: null as any, oncancel: null as any,
        currentTime: 0, playState: "finished" as const,
      };
    };
    (node as any).hasPointerCapture = () => false;
    (node as any).setPointerCapture = () => {};
    (node as any).releasePointerCapture = () => {};
    (node as any).scrollIntoView = () => {};
    (node as any).scrollTo = () => {};
    (node as any).scrollBy = () => {};
    (node as any).getClientRects = () => [];
    // Text-input selection API. Rename/new-file inputs focus() then
    // setSelectionRange()/select() to highlight the filename (minus its
    // extension). The scene input primitive doesn't model a selection range
    // yet, so these are shaped no-ops — they stop the "not a function" throw
    // that otherwise blanks the whole file tree when a rename begins.
    (node as any).select = () => {};
    (node as any).setSelectionRange = () => {};
    (node as any).setRangeText = () => {};
    (node as any).selectionStart = 0;
    (node as any).selectionEnd = 0;
    (node as any).selectionDirection = "none";
    // matches/closest: libraries (Radix UI especially) test ancestry — e.g.
    // a checkbox/switch does `ref.closest("form")` to decide whether to render
    // a hidden form input. Without these the call throws "not a function" and
    // the whole component subtree fails to mount. We support the simple
    // selectors these libraries actually use: tag, #id, .class, [attr],
    // [attr="v"]; compound/descendant selectors degrade to false.
    (node as any).matches = (selector: string): boolean => {
      if (!selector || typeof selector !== "string") return false;
      const np: any = (node as any)._props || {};
      const tag = String((node as any).tagName || "").toUpperCase();
      // className/id live in the node's props (node.id is the numeric scene id,
      // NOT the HTML id attribute).
      const cls = String(np.className ?? np.class ?? "");
      const htmlId = np.id != null ? String(np.id) : null;
      const classes = cls ? cls.split(/\s+/) : [];
      for (const raw of selector.split(",")) {
        const s = raw.trim();
        if (!s) continue;
        let ok = true;
        // Split a single compound selector into its simple pieces.
        const parts = s.match(/[#.\[][^#.\[]+|^[a-zA-Z][\w-]*/g) || [];
        if (parts.length === 0) { ok = false; }
        for (const p of parts) {
          if (p.startsWith("#")) {
            if (htmlId !== p.slice(1)) { ok = false; break; }
          } else if (p.startsWith(".")) {
            if (!classes.includes(p.slice(1))) { ok = false; break; }
          } else if (p.startsWith("[")) {
            const m = /^\[([\w-]+)(?:[~|^$*]?=["']?([^"'\]]*)["']?)?\]$/.exec(p);
            if (!m) { ok = false; break; }
            const av = np[m[1]] ?? (m[1].startsWith("data-") || m[1].startsWith("aria-")
              ? np[m[1]] : undefined);
            if (av == null) { ok = false; break; }
            if (m[2] != null && String(av) !== m[2]) { ok = false; break; }
          } else {
            // tag selector ("*" matches anything)
            if (p !== "*" && p.toUpperCase() !== tag) { ok = false; break; }
          }
        }
        if (ok) return true;
      }
      return false;
    };
    (node as any).closest = (selector: string): any => {
      let cur: any = node;
      while (cur) {
        if (typeof cur.matches === "function" && cur.matches(selector)) return cur;
        cur = cur.parent ?? cur.parentNode ?? null;
      }
      return null;
    };
    // Minimal query API: subtree search by the same simple selectors. Returns
    // null / [] when nothing matches (prevents crashes in libraries that probe
    // the DOM, e.g. focus-scope / dismissable-layer).
    (node as any).querySelectorAll = (selector: string): any[] => {
      const out: any[] = [];
      const walk = (n: any) => {
        const kids: any[] = (n && n.children) || [];
        for (const k of kids) {
          if (typeof k?.matches === "function" && k.matches(selector)) out.push(k);
          walk(k);
        }
      };
      walk(node);
      return out;
    };
    (node as any).querySelector = (selector: string): any =>
      (node as any).querySelectorAll(selector)[0] ?? null;
    // Route layout measurement through the runtime so libraries that
    // depend on box dimensions (react-resizable-panels, framer-motion,
    // floating-ui, etc.) actually see the taffy-computed layout.
    // __cm_layout_box(id) → "x,y,w,h" string (empty if id not in tree).
    const measure = (): { x: number; y: number; w: number; h: number } => {
      try {
        const lb = (globalThis as any).__cm_layout_box;
        if (typeof lb !== "function") return { x: 0, y: 0, w: 0, h: 0 };
        const raw = lb(node.id);
        if (!raw) return { x: 0, y: 0, w: 0, h: 0 };
        const [x, y, w, h] = String(raw).split(",").map(Number);
        return { x: x || 0, y: y || 0, w: w || 0, h: h || 0 };
      } catch { return { x: 0, y: 0, w: 0, h: 0 }; }
    };
    (node as any).getBoundingClientRect = () => {
      const r = measure();
      return {
        x: r.x, y: r.y, width: r.w, height: r.h,
        top: r.y, left: r.x, right: r.x + r.w, bottom: r.y + r.h,
        toJSON() { return this; },
      };
    };
    Object.defineProperty(node, "offsetWidth",  { get: () => measure().w, configurable: true });
    Object.defineProperty(node, "offsetHeight", { get: () => measure().h, configurable: true });
    Object.defineProperty(node, "offsetLeft",   { get: () => measure().x, configurable: true });
    Object.defineProperty(node, "offsetTop",    { get: () => measure().y, configurable: true });
    Object.defineProperty(node, "clientWidth",  { get: () => measure().w, configurable: true });
    Object.defineProperty(node, "clientHeight", { get: () => measure().h, configurable: true });
    Object.defineProperty(node, "scrollWidth",  { get: () => measure().w, configurable: true });
    Object.defineProperty(node, "scrollHeight", { get: () => measure().h, configurable: true });
    (node as any).focus = () => {};
    (node as any).blur = () => {};
    (node as any).click = () => {};
    (node as any).scrollIntoView = () => {};
    (node as any).querySelector = () => null;
    (node as any).querySelectorAll = () => [];
    Object.defineProperty(node, "parentNode", {
      get() { return (this as any).parent; },
      configurable: true,
    });
    Object.defineProperty(node, "nextSibling", {
      get() {
        const p = (this as any).parent;
        if (!p) return null;
        const i = p.children.indexOf(this);
        return p.children[i + 1] ?? null;
      },
      configurable: true,
    });
    Object.defineProperty(node, "previousSibling", {
      get() {
        const p = (this as any).parent;
        if (!p) return null;
        const i = p.children.indexOf(this);
        return p.children[i - 1] ?? null;
      },
      configurable: true,
    });
    Object.defineProperty(node, "firstChild", {
      get() { return (this as any).children[0] ?? null; },
      configurable: true,
    });
    Object.defineProperty(node, "lastChild", {
      get() {
        const c = (this as any).children;
        return c[c.length - 1] ?? null;
      },
      configurable: true,
    });
    // `childNodes` alias so @carbon/compat-dom's detach/move logic (which
    // splices a child out of `parent.childNodes`) works when the old
    // parent is a @carbon/mini-react node — e.g. xterm's host div being
    // moved back from a React pane container into the offscreen recycler.
    Object.defineProperty(node, "childNodes", {
      get() { return (this as any).children; },
      configurable: true,
    });
    // Real DOM child ops bridged to the scene graph. These let libraries
    // that imperatively mount into a React-held ref (xterm.open(host),
    // Radix portals, etc.) attach their @carbon/compat-dom nodes UNDER a
    // @carbon/mini-react container. We accept children from either DOM
    // impl: react nodes carry `.id`, @carbon/compat-dom nodes carry `.cmId`.
    const sceneIdOf = (c: any): number =>
      (typeof c?.cmId === "number" ? c.cmId : c?.id);
    // Non-destructive detach from whatever parent the child is under, so a
    // MOVE doesn't delete the child's scene node (mirrors @carbon/compat-dom's
    // detachForMove). The scene-side reparent is handled by __cm_insert_node.
    const detachForMove = (child: any) => {
      const p = child?.parent ?? child?.parentNode;
      if (!p) return;
      const list: any[] | null = Array.isArray(p.children)
        ? p.children
        : Array.isArray(p.childNodes)
          ? p.childNodes
          : null;
      if (list) { const i = list.indexOf(child); if (i >= 0) list.splice(i, 1); }
      try { child.parent = null; } catch { /* shim nodes have no .parent */ }
      try { child.parentNode = null; } catch { /* react nodes alias parentNode→parent */ }
    };
    (node as any).appendChild = (child: any) => {
      if (!child) return child;
      detachForMove(child);
      (node as any).children.push(child);
      child.parent = node;
      try { child.parentNode = node; } catch { /* getter-only on react nodes */ }
      __cm_insert_node(node.id, sceneIdOf(child), -1);
      __cm_request_paint();
      return child;
    };
    (node as any).insertBefore = (child: any, ref: any) => {
      if (!child) return child;
      detachForMove(child);
      const kids = (node as any).children as any[];
      const idx = ref ? kids.indexOf(ref) : -1;
      if (idx >= 0) kids.splice(idx, 0, child); else kids.push(child);
      child.parent = node;
      try { child.parentNode = node; } catch { /* getter-only */ }
      __cm_insert_node(node.id, sceneIdOf(child), ref ? sceneIdOf(ref) : -1);
      __cm_request_paint();
      return child;
    };
    (node as any).removeChild = (child: any) => {
      const kids = (node as any).children as any[];
      const i = kids.indexOf(child);
      if (i >= 0) kids.splice(i, 1);
      if (child) {
        try { if (child.parent === node) child.parent = null; } catch { /* noop */ }
        try { if (child.parentNode === node) child.parentNode = null; } catch { /* noop */ }
        __cm_remove_node(sceneIdOf(child));
      }
      __cm_request_paint();
      return child;
    };
    (node as any).append = (...kids: any[]) => { for (const k of kids) (node as any).appendChild(k); };
    return node;
  },

  createTextInstance(text: string): CmNode {
    const node = freshNode("text", true);
    const s = String(text);
    __cm_set_text(node.id, s);
    nodeTexts.set(node.id, s);
    return node;
  },

  // ── Initial mount ─────────────────────────────────────────────────────
  appendInitialChild(parent: CmNode, child: CmNode): void {
    parent.children.push(child);
    child.parent = parent;
    __cm_insert_node(parent.id, child.id, -1);
  },

  finalizeInitialChildren(): boolean {
    return false;
  },

  // ── Mutation ──────────────────────────────────────────────────────────
  appendChild(parent: CmNode, child: CmNode): void {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    parent.children.push(child);
    child.parent = parent;
    __cm_insert_node(parent.id, child.id, -1);
    reResolveSubtree(child);
    __cm_request_paint();
  },

  appendChildToContainer(parent: CmNode, child: CmNode): void {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    // The container may be a @carbon/compat-dom node (document.body, a Radix
    // portal target), whose `.children` isn't a plain array and whose scene
    // id is `.cmId` — so guard the JS-graph push and resolve via sceneIdOf.
    if (Array.isArray((parent as any).children)) (parent as any).children.push(child);
    child.parent = parent;
    __cm_insert_node(sceneIdOf(parent), sceneIdOf(child), -1);
    // Tree is fully wired now (this is the React root mount). Walk the
    // entire subtree and re-resolve classNames so deep group-data /
    // peer-data variants pick up ancestors that weren't in the chain
    // when applyProps first ran from createInstance.
    reResolveSubtree(child);
    __cm_request_paint();
  },

  insertBefore(parent: CmNode, child: CmNode, before: CmNode): void {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    const idx = parent.children.indexOf(before);
    parent.children.splice(idx < 0 ? parent.children.length : idx, 0, child);
    child.parent = parent;
    __cm_insert_node(parent.id, child.id, before.id);
    reResolveSubtree(child);
    __cm_request_paint();
  },

  insertInContainerBefore(parent: CmNode, child: CmNode, before: CmNode): void {
    // Container variant of insertBefore: parent may be a @carbon/compat-dom node
    // (portal target). Resolve scene ids via sceneIdOf and guard the JS-graph
    // splice the same way appendChildToContainer does.
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    if (Array.isArray((parent as any).children)) {
      const idx = (parent as any).children.indexOf(before);
      (parent as any).children.splice(idx < 0 ? (parent as any).children.length : idx, 0, child);
    }
    child.parent = parent;
    __cm_insert_node(sceneIdOf(parent), sceneIdOf(child), sceneIdOf(before));
    reResolveSubtree(child);
    __cm_request_paint();
  },

  removeChild(parent: CmNode, child: CmNode): void {
    const i = parent.children.indexOf(child);
    if (i >= 0) parent.children.splice(i, 1);
    child.parent = null;
    clickHandlers.delete(child.id);
    inputHandlers.delete(child.id);
    nodeTexts.delete(child.id);
    eventHandlers.delete(child.id);
    nodeRegistry.delete(child.id);
    __cm_remove_node(child.id);
    __cm_request_paint();
  },

  removeChildFromContainer(parent: CmNode, child: CmNode): void {
    if (Array.isArray((parent as any).children)) {
      const i = (parent as any).children.indexOf(child);
      if (i >= 0) (parent as any).children.splice(i, 1);
    }
    child.parent = null;
    clickHandlers.delete(sceneIdOf(child));
    inputHandlers.delete(sceneIdOf(child));
    nodeTexts.delete(sceneIdOf(child));
    eventHandlers.delete(sceneIdOf(child));
    nodeRegistry.delete(sceneIdOf(child));
    __cm_remove_node(sceneIdOf(child));
    __cm_request_paint();
  },

  // ── Updates (React 18 mutation mode) ──────────────────────────────────
  // React 18's reconciler skips prepareUpdate and calls commitUpdate with
  // (instance, type, oldProps, newProps). We re-apply newProps wholesale —
  // simpler than diffing both ways and equivalent in effect for our
  // scene-prop model where setting a prop is idempotent.
  prepareUpdate(): unknown {
    return true;
  },

  commitUpdate(
    instance: CmNode,
    _payload: unknown,
    type: string,
    _oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ): void {
    // Text-children collapse must run on update too — otherwise a re-render
    // of `<text>Count: {count}</text>` after `setCount(c+1)` would never
    // refresh the displayed text (commitUpdate without this branch only
    // applied props, not children).
    if (type === "text" && allStringLikeChildren(newProps.children)) {
      const s = flattenStringChildren(newProps.children);
      __cm_set_text(instance.id, s);
      nodeTexts.set(instance.id, s);
    }
    // Wipe the node's paint-related props back to defaults before
    // re-applying. Without this, conditional styles from the OLD render
    // (e.g. `data-active:bg-X` when the previous render had data-state=
    // active and the new one doesn't) would linger because __cm_set_prop
    // only overwrites keys that get re-sent.
    const reset = (globalThis as unknown as { __cm_reset_paint_props?: (id: number) => void }).__cm_reset_paint_props;
    if (typeof reset === "function") reset(instance.id);
    applyProps(instance, newProps);
  },

  commitTextUpdate(textNode: CmNode, _oldText: string, newText: string): void {
    const s = String(newText);
    __cm_set_text(textNode.id, s);
    nodeTexts.set(textNode.id, s);
    __cm_request_paint();
  },

  resetTextContent(): void {
    // No-op: our text is owned by Text nodes, not the parent.
  },

  // ── Suspense / Offscreen visibility ───────────────────────────────────
  // react-reconciler calls these during commit to hide/show a subtree
  // without unmounting it — e.g. a <Suspense> boundary showing its fallback
  // while a lazy() child loads. They are REQUIRED in mutation mode; leaving
  // them off makes React call `undefined(instance)` mid-commit, throwing
  // "TypeError: not a function" and blanking the whole window the moment any
  // Suspense/lazy boundary commits (terax lazy-loads its editor/AI panes).
  // We mirror react-dom: toggle `display:none`, restoring the prior value
  // on unhide (from the instance's own style props, else the element
  // default).
  hideInstance(instance: CmNode): void {
    __cm_set_prop(instance.id, "display", JSON.stringify("none"));
    __cm_request_paint();
  },
  unhideInstance(instance: CmNode, props: Record<string, unknown>): void {
    const style = props?.style as { display?: unknown } | undefined;
    const disp = typeof style?.display === "string" ? style.display : "";
    __cm_set_prop(instance.id, "display", JSON.stringify(disp));
    __cm_request_paint();
  },
  hideTextInstance(textInstance: CmNode): void {
    __cm_set_prop(textInstance.id, "display", JSON.stringify("none"));
    __cm_request_paint();
  },
  unhideTextInstance(textInstance: CmNode): void {
    __cm_set_prop(textInstance.id, "display", JSON.stringify(""));
    __cm_request_paint();
  },

  shouldSetTextContent(type: string, props: Record<string, unknown>): boolean {
    // Return true for `<text>` elements whose children are all string-like —
    // tells React not to create separate text-instance children for them.
    // Critical for correct layout: without this, `<text>foo {bar}</text>`
    // becomes an outer text + two text-instance children that flex-column-
    // stack vertically, producing the broken "label / value" stacking we
    // saw in the metadata row and tag chips.
    return type === "text" && allStringLikeChildren(props.children);
  },

  clearContainer(container: CmNode): void {
    while (container.children.length) {
      const child = container.children.pop()!;
      child.parent = null;
      clickHandlers.delete(child.id);
      nodeTexts.delete(child.id);
      __cm_remove_node(child.id);
    }
    __cm_request_paint();
  },

  // ── Context (we don't use host context) ───────────────────────────────
  getRootHostContext(): null {
    return null;
  },
  getChildHostContext(): null {
    return null;
  },

  // ── Commit phase ──────────────────────────────────────────────────────
  prepareForCommit(): null {
    return null;
  },
  resetAfterCommit(): void {
    __cm_request_paint();
  },
  preparePortalMount(): void {},

  // ── Public instance ───────────────────────────────────────────────────
  getPublicInstance(node: CmNode): CmNode {
    return node;
  },

  // ── Scheduling ────────────────────────────────────────────────────────
  scheduleTimeout(fn: (...args: unknown[]) => unknown, delay: number): number {
    return setTimeout(fn, delay) as unknown as number;
  },
  cancelTimeout(id: number): void {
    clearTimeout(id);
  },
  scheduleMicrotask(fn: () => unknown): void {
    queueMicrotask(fn);
  },

  // ── Event priority — same lane every event for our single-input model ─
  getCurrentEventPriority(): number {
    return DefaultEventPriority;
  },

  // ── Refs / scopes / activity / suspense — unused stubs ────────────────
  detachDeletedInstance(): void {},
  beforeActiveInstanceBlur(): void {},
  afterActiveInstanceBlur(): void {},
  prepareScopeUpdate(): void {},
  getInstanceFromScope(): null {
    return null;
  },
  getInstanceFromNode(): null {
    return null;
  },
  trackSchedulerEvent(): void {},
  resolveEventType(): null {
    return null;
  },
  resolveEventTimeStamp(): number {
    return -1.1;
  },
  requestPostPaintCallback(): void {},
  maySuspendCommit(): boolean {
    return false;
  },
  preloadInstance(): boolean {
    return true;
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady(): null {
    return null;
  },
  NotPendingTransition: null,
  HostTransitionContext: { $$typeof: Symbol.for("react.context"), Provider: null, _currentValue: null, _currentValue2: null, _threadCount: 0, Consumer: null, displayName: "" },
};

const reconciler = ReactReconciler(hostConfig);

// ─── Mount API ────────────────────────────────────────────────────────────
const ROOT_ID = 1;
let rootNode: CmNode | null = null;
let containerHandle: any = null;

function getRoot(): CmNode {
  if (!rootNode) {
    // Root view fills the window AND lays out children in a column so
    // app-level `h-screen flex-col` containers behave as expected. The
    // React-DOM convention is that <body> is full-height with no
    // intrinsic layout — but our scene doesn't expose that automatic
    // window-sizing through CSS, so we wire it explicitly.
    __cm_create_node(
      ROOT_ID,
      "view",
      JSON.stringify({
        width: "100%",
        height: "100%",
        "flex-direction": "column",
      }),
    );
    __cm_set_root(ROOT_ID);
    rootNode = { id: ROOT_ID, tag: "view", isText: false, parent: null, children: [] };
  }
  return rootNode;
}

/**
 * Mount a React element tree into the carbon-mini scene root.
 * Subsequent calls re-render the same root (React's standard root API).
 *
 *   import { render } from "@carbon/mini-react";
 *   import App from "./App";
 *   render(<App />);
 */
export function render(element: any): void {
  // ─── Heap-snapshot deferred mount ───────────────────────────────────────
  // When carbon-mini builds a startup snapshot it evaluates the bundle purely
  // for module-init (defining React, the app's components, building the
  // `<App/>` element) and must NOT perform the actual mount — the mount calls
  // host imports (`__cm_create_node`, …) and reads back layout, none of which
  // exist at snapshot-build time, and doing it would also bake renderer state
  // the snapshot can't carry. So if the runtime set `__cm_defer_mount`, stash
  // the mount as a thunk (a plain JS closure that survives in the snapshot
  // heap) and return. After restoring the heap and registering the real host
  // imports, the runtime clears the flag and calls `__cm_run_deferred_mount()`,
  // which performs the mount fresh in the user's session.
  if ((globalThis as any).__cm_defer_mount) {
    (globalThis as any).__cm_run_deferred_mount = () => {
      (globalThis as any).__cm_defer_mount = false;
      render(element);
    };
    return;
  }
  const root = getRoot();
  if (!containerHandle) {
    // react-reconciler 0.29.x signature (React 18.3-compatible). The 0.30+
    // signature splits the error-handler argument into three separate ones
    // (onUncaughtError, onCaughtError, onRecoverableError); we pass the
    // react-reconciler 0.29 (React 18) arg shape. The React 19 / 0.31
    // shape (onUncaughtError + onCaughtError inserted) is a separate
    // upgrade task — that reconciler also renamed flushSync and changed
    // host-config interface in ways that go beyond a simple arg swap.
    containerHandle = (reconciler as any).createContainer(
      root,
      ConcurrentRoot,
      null,                       // hydrationCallbacks
      false,                      // isStrictMode
      null,                       // concurrentUpdatesByDefaultOverride
      "",                         // identifierPrefix
      (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[@carbon/mini-react] recoverable error:", err);
      },
      null,                       // transitionCallbacks
    );
  }
  // Wrap updateContainer in flushSync. With supportsMicrotasks:true, the
  // reconciler schedules its initial commit via queueMicrotask — but
  // carbon-mini's rquickjs host does NOT drain pending microtasks between
  // bundle eval and the first paint. Without flushSync the tree never
  // commits and the window stays empty. flushSync forces the work loop to
  // run synchronously so every __cm_create_node / __cm_set_prop call lands
  // before render() returns.
  const flush = resolveFlushSync();
  if (flush) {
    flush(() => {
      reconciler.updateContainer(element, containerHandle, null, () => {});
    });
  } else {
    // Reconciler doesn't expose a sync-flush API on this version —
    // attempt a plain commit. The first paint may show a partial tree
    // until rAF schedules a microtask drain.
    reconciler.updateContainer(element, containerHandle, null, () => {});
  }
  __cm_request_paint();

  // Expose a global force-flush so the host runtime can drain pending
  // React work after every JS-touching event. ConcurrentRoot defers
  // async setState() updates (Promise.then → setState, etc.) until a
  // "natural event boundary" that browsers have but carbon-mini lacks
  // — flushing here turns each microtask-drain tick into one of those
  // boundaries, so async state updates actually commit instead of
  // queueing forever.
  (globalThis as unknown as { __cm_flush_react?: () => void }).__cm_flush_react = () => {
    try {
      resolveFlushSync()?.(() => {});
    } catch { /* no-op if no work pending */ }
  };
}

// ─── react-dom/client compatibility ──────────────────────────────────────
//
// React apps coming from a normal browser/Tauri setup write:
//
//   import ReactDOM from "react-dom/client";
//   ReactDOM.createRoot(document.getElementById("root")).render(<App />);
//
// To let those apps run on carbon-mini without touching their entry, the
// build pipeline rewrites `react-dom/client` imports to point at this
// module. We expose `createRoot` (and `hydrateRoot`) with the same shape
// react-dom does — the returned root delegates to our scene-graph
// reconciler.
//
// The container argument is honored only for its semantic intent (the
// app picked a DOM node to mount into); the actual rendering target is
// always the carbon-mini scene root because the runtime owns the
// window's surface.

export interface RootApi {
  render(element: any): void;
  unmount(): void;
}

export function createRoot(_container: unknown, _options?: unknown): RootApi {
  // _container is whatever document.getElementById returned. We don't
  // need it — render() always targets the scene root.
  return {
    render(element: any) { render(element); },
    unmount() {
      if (containerHandle) {
        try { reconciler.updateContainer(null, containerHandle, null, () => {}); } catch {}
        containerHandle = null;
      }
    },
  };
}

// Hydration in carbon-mini is the same as fresh render — there's no
// server-rendered HTML to attach to. Apps using SSR transitions should
// migrate to plain createRoot.
export function hydrateRoot(container: unknown, initialChildren: any, _options?: unknown): RootApi {
  const r = createRoot(container);
  r.render(initialChildren);
  return r;
}

// flushSync — react-dom's escape hatch for forcing a synchronous
// commit. Radix, floating-ui, and other libraries call it after
// imperative DOM mutations to make React reconcile immediately. We
// delegate to the reconciler's flushSync since our commit pipeline
// is the same.
export function flushSync<T>(fn: () => T): T {
  let result: T = undefined as any;
  (reconciler as any).flushSync(() => {
    result = fn();
  });
  __cm_request_paint();
  return result;
}

// createPortal — render children into a different parent. Carbon-mini
// is single-window, so there's nowhere to portal to that's outside the
// scene tree. We render children at the scene root so popovers /
// tooltips visually escape their containing flex box. The `container`
// arg is honored by id when it's a CmNode; otherwise the scene root
// is used as the target.
export function createPortal(children: any, container?: any, key?: any): any {
  // React-DOM uses a special $$typeof Symbol.for("react.portal"); we
  // mirror that so React-internal isPortal checks pass.
  const REACT_PORTAL_TYPE = Symbol.for("react.portal");
  // Pick the portal mount target. Radix's DropdownMenu / Tooltip /
  // Dialog all portal to document.body by default; @carbon/compat-dom's
  // body is a CarbonElement with `cmId` (not `id`). Accept anything
  // that looks like a carbon node — `cmId`, `id`, or our internal
  // numeric id — falling back to the scene root when the caller
  // passes something we can't recognise (or undefined for the
  // current-document body case).
  const looksLikeCmNode = (n: any): boolean =>
    !!n && typeof n === "object" && (
      typeof (n as { cmId?: unknown }).cmId === "number" ||
      typeof (n as { id?: unknown }).id === "number"
    );
  const targetNode = looksLikeCmNode(container) ? container : getRoot();
  return {
    $$typeof: REACT_PORTAL_TYPE,
    key: key == null ? null : String(key),
    children,
    containerInfo: targetNode,
    implementation: null,
  };
}

// react-dom default export — apps that do `import ReactDOM from
// "react-dom/client"` get an object with createRoot/hydrateRoot on it.
const reactDomClient = { createRoot, hydrateRoot, flushSync, createPortal };
export default reactDomClient;

// ─── HMR — survives bundle re-eval, like carbon/runtime/engine/paint/renderers/solid ────────────
(globalThis as any).__cm_hmr_reset = () => {
  if (containerHandle) {
    try {
      reconciler.updateContainer(null, containerHandle, null, () => {});
    } catch {}
    containerHandle = null;
  }
  rootNode = null;
  clickHandlers.clear();
  inputHandlers.clear();
  nodeTexts.clear();
  eventHandlers.clear();
  nodeRegistry.clear();
};

// ─── Test API for AI agents / automated tests ────────────────────────────
// Mirrors carbon/runtime/engine/paint/renderers/solid's __cm_test surface so the same harness
// works for both adapters.

interface TestNode {
  id: number;
  tag: string;
  text?: string;
  children: TestNode[];
}

function serializeNodeTree(node: CmNode): TestNode {
  return {
    id: node.id,
    tag: node.tag,
    text: nodeTexts.get(node.id),
    children: node.children.map(serializeNodeTree),
  };
}

function findNodesByText(node: CmNode | null, text: string, results: TestNode[] = []): TestNode[] {
  if (!node) return results;
  if (nodeTexts.get(node.id) === text) results.push(serializeNodeTree(node));
  node.children.forEach((c) => findNodesByText(c, text, results));
  return results;
}

function findNodesByTag(node: CmNode | null, tag: string, results: TestNode[] = []): TestNode[] {
  if (!node) return results;
  if (node.tag === tag) results.push(serializeNodeTree(node));
  node.children.forEach((c) => findNodesByTag(c, tag, results));
  return results;
}

function findClickableAncestor(startId: number): number | null {
  function findLive(node: CmNode | null, id: number): CmNode | null {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
      const f = findLive(c, id);
      if (f) return f;
    }
    return null;
  }
  let cur = findLive(rootNode, startId);
  while (cur) {
    if (clickHandlers.has(cur.id)) return cur.id;
    cur = cur.parent;
  }
  return null;
}

(globalThis as any).__cm_test = {
  findByText(text: string): TestNode[] { return findNodesByText(rootNode, text); },
  findByTag(tag: string): TestNode[] { return findNodesByTag(rootNode, tag); },
  dump(): string { return JSON.stringify(rootNode ? serializeNodeTree(rootNode) : null); },
  clickId(id: number): void {
    const target = clickHandlers.has(id) ? id : findClickableAncestor(id);
    if (target != null) {
      (globalThis as any).__cm_dispatch_click?.(target);
      __cm_request_paint();
    }
  },
  clickText(text: string): void {
    const nodes = findNodesByText(rootNode, text);
    if (nodes.length > 0) (globalThis as any).__cm_test.clickId(nodes[0].id);
  },
  triggerPaint(): void { __cm_request_paint(); },
};

// Re-export common React things so apps can do single-import.
export { default as React } from "react";
