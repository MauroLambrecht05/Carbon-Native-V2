// The DOM face every host node wears.
//
// A CmNode is five fields. Almost none of the React ecosystem is willing to
// talk to five fields: Radix probes `closest("form")` and `getAnimations()`,
// framer-motion writes `element.style.*` imperatively every frame, floating-ui
// and react-resizable-panels read `getBoundingClientRect()`, xterm calls
// `appendChild` on a ref it was handed. A missing method is not a degraded
// feature — it throws "not a function" mid-commit and blanks the window.
//
// So every instance gets decorated with the smallest DOM-shaped surface that
// keeps those call sites round-tripping. Some of it is real (style writes and
// child ops reach the scene; measurement reads taffy's computed layout);
// some of it is a shaped no-op (pointer capture, WAAPI, selection ranges),
// which is the correct inert answer for a scene graph that does not model
// them.
//
// It lives in its own file because it is not the reconciler and it is not the
// node — it is the compatibility tax, and reading the HostConfig should not
// mean reading 340 lines of it first.

import "../host/imports.ts";
import type { CmNode } from "./node.ts";

export function decorateAsDomNode(node: CmNode, type: string): void {
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
  // Real, not shaped no-ops: the native focus/click/scrollIntoView paths
  // already exist (they're what a real pointer event already drives) —
  // these just make them reachable imperatively, which refs need for
  // autofocus-on-mount, refocus-after-validation-error, and
  // programmatic "scroll the invalid field into view" (all common
  // React patterns that previously did nothing at all).
  (node as any).focus = () => {
    try { (globalThis as any).__cm_set_focus?.(node.id); } catch { /* pre-ready */ }
  };
  (node as any).blur = () => {
    try { (globalThis as any).__cm_set_focus?.(-1); } catch { /* pre-ready */ }
  };
  (node as any).click = () => {
    // Same dispatcher a real pointer-up already calls into (events.ts) —
    // calling it directly in-process needs no round-trip through Rust.
    try { (globalThis as any).__cm_dispatch_click?.(node.id); } catch { /* pre-ready */ }
  };
  (node as any).scrollIntoView = () => {
    try { (globalThis as any).__cm_scroll_into_view?.(node.id); } catch { /* pre-ready */ }
  };
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
}
