// Node / Element / Text — the Tier-1 DOM tree backed by carbon-mini's
// __cm_* scene-graph host imports.
//
// What this is for: framework rendering. React, Preact, Vue, Lit, Svelte,
// lit-html call `document.createElement`, `el.appendChild`, `el.setAttribute`
// etc. — we satisfy those calls by maintaining a parallel CmNode in the
// runtime. Each DOM tree mutation translates to one or two __cm_* calls.
//
// What this is NOT for: layout reads (getBoundingClientRect returns zeros),
// CSSOM (computed styles aren't computed), MutationObservers, IntersectionObserver,
// ResizeObserver, Selection/Range, focus management, IME, drag/drop, or any
// of the "real browser" APIs that real apps rely on. See the package README
// for the explicit scope.

import { attachCanvas, ensureSystemFont } from "./canvas.ts";
import { applyStylesheetTo, registerStylesheet, hasStylesheets } from "./css.ts";

declare const __cm_create_node: (id: number, tag: string, propsJson: string) => void;
declare const __cm_set_text: (id: number, text: string) => void;
declare const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
declare const __cm_insert_node: (parentId: number, childId: number, beforeId: number) => void;
declare const __cm_remove_node: (id: number) => void;
declare const __cm_set_root: (id: number) => void;
declare const __cm_request_paint: () => void;
declare const __cm_layout_box: (id: number) => string;

// readLayoutBox — synchronous DOM-style measurement. Triggers a taffy
// layout pass on the runtime side, returns the computed absolute box
// for the node. Cached per call to avoid duplicate layout passes when
// a library reads multiple properties (offsetWidth + offsetHeight +
// getBoundingClientRect) back-to-back in the same microtask.
let _lbCache: Map<number, { x: number; y: number; w: number; h: number }> | null = null;
let _lbCacheTick = 0;
function readLayoutBox(id: number): { x: number; y: number; w: number; h: number } {
  // Bust the cache when the JS event loop yields. A measurement burst
  // inside a single sync block reuses it; the next event-loop iteration
  // gets fresh values.
  if (_lbCache && _lbCacheTick !== currentTick()) _lbCache = null;
  if (!_lbCache) {
    _lbCache = new Map();
    _lbCacheTick = currentTick();
  }
  const hit = _lbCache.get(id);
  if (hit) return hit;
  const result = (() => {
    if (typeof __cm_layout_box !== "function") return { x: 0, y: 0, w: 0, h: 0 };
    const raw = __cm_layout_box(id);
    if (!raw) return { x: 0, y: 0, w: 0, h: 0 };
    const [x, y, w, h] = raw.split(",").map(Number);
    return { x: x || 0, y: y || 0, w: w || 0, h: h || 0 };
  })();
  _lbCache.set(id, result);
  return result;
}

function currentTick(): number {
  // setTimeout(0)/microtask flush counter, approximated by performance.now()
  // bucketed at 1ms. Good enough to invalidate the cache between
  // user-perceptible frames without thrashing during a single render
  // pass.
  return Math.floor((globalThis as any).performance?.now?.() ?? Date.now());
}

// Shared, process-wide node-id allocator.
//
// Every carbon adapter that emits scene nodes (@carbon/mini-react,
// @carbon/compat-dom, mini-runtime, @carbon/term) calls
// __cm_create_node(id, …) into the SAME Rust scene map, where
// `nodes.insert(id, …)` overwrites on collision. When two adapters coexist
// in one JS context — e.g. a React app (@carbon/mini-react) that also pulls
// in a direct-DOM library like xterm or Radix portals (which go through this
// shim) — each having its own `let nextId = 100` makes their id ranges
// overlap, so one adapter's nodes silently clobber the other's. That
// manifested as terax's whole React tree being overwritten by xterm's
// span/text nodes (a 30k-px-tall garbage column).
//
// Drawing every id from one counter on globalThis guarantees uniqueness
// across adapters. A single adapter behaves identically to before (counter
// still starts at 100).
function nextNodeId(): number {
  const g = globalThis as { __cm_node_id_seq?: number };
  const next = (typeof g.__cm_node_id_seq === "number" ? g.__cm_node_id_seq : 99) + 1;
  g.__cm_node_id_seq = next;
  return next;
}

/** Non-destructive detach: unlink `child` from its current parent's JS
 *  child list WITHOUT deleting its scene node. Used by appendChild /
 *  insertBefore so that MOVING an already-attached node (standard DOM
 *  semantics) doesn't route through `removeChild` → `__cm_remove_node`,
 *  which would delete the node + its whole subtree from the scene and then
 *  re-insert a dead id. The scene reparent is handled by `__cm_insert_node`
 *  (which now detaches from the old parent). Handles a parent from either
 *  DOM impl: @carbon/compat-dom uses `childNodes`, @carbon/mini-react uses
 *  `children`. */
function detachForMove(child: { parentNode?: any }): void {
  const p = child.parentNode;
  if (!p) return;
  const list: any[] | null = Array.isArray(p.childNodes)
    ? p.childNodes
    : Array.isArray(p.children)
      ? p.children
      : null;
  if (list) {
    const i = list.indexOf(child);
    if (i >= 0) list.splice(i, 1);
  }
  // @carbon/mini-react nodes expose `parentNode` as a getter over `.parent`,
  // so assign through whichever is writable.
  try { child.parentNode = null; } catch { /* getter-only */ }
  try { if ("parent" in child) child.parent = null; } catch { /* noop */ }
}

// Tags that carry no visual content — never painted. Their scene node is
// marked display:none so the runtime skips it (and its text children).
const NON_VISUAL_TAGS = new Set([
  "style", "script", "head", "title", "meta", "link", "base", "noscript",
  "template",
]);

// Node types per the WHATWG DOM spec.
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;

/** Click handlers keyed by cmId. The Rust hit-test path evals
 *  `globalThis.__cm_dispatch_click(<id>)` which lands here.
 *  We re-fire the fake event up the parent chain. */
const clickListeners = new Map<number, Set<EventListener>>();

(globalThis as any).__cm_dispatch_click = (cmId: number) => {
  const target = nodeRegistry.get(cmId);
  if (!target) return;
  const evt = new CarbonEvent("click", { bubbles: true, cancelable: true });
  (evt as any).target = target;
  target.dispatchEvent(evt);
  __cm_request_paint();
};

// Pointer/mouse bridge. The runtime calls `__cm_dispatch_pointer(id, phase,
// x, y, button)` on mouse down/up/move over the hit-tested element. We fire
// the corresponding pointer* AND mouse* DOM events (both bubble), because
// libraries split across the two: xterm.js focuses its hidden textarea from
// a `mousedown` handler, drag libraries use `pointerdown`, etc. Without this
// in a React app (where the Solid mini-runtime that used to define this
// isn't loaded) the terminal never receives a press and never focuses.
(globalThis as any).__cm_dispatch_pointer = (
  cmId: number,
  phase: string,
  x: number,
  y: number,
  button: number,
) => {
  const target = nodeRegistry.get(cmId);
  if (!target) return;
  const types =
    phase === "down" ? ["pointerdown", "mousedown"]
    : phase === "up" ? ["pointerup", "mouseup"]
    : phase === "move" ? ["pointermove", "mousemove"]
    : [];
  for (const t of types) {
    const ev = new CarbonMouseEvent(t, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: button | 0,
    });
    (ev as any).target = target;
    try { target.dispatchEvent(ev); } catch { /* swallow listener errors */ }
  }
  __cm_request_paint();
};

// Wheel bridge. The runtime calls `__cm_dispatch_wheel(id, dX, dY, x, y)` on
// the element under the cursor (deltas in CSS pixels). We fire a bubbling
// `wheel` DOM event so xterm.js (and any overflow scroller) can scroll its
// own buffer/content — its listener sits on an ancestor of the hit node, so
// the event reaches it by bubbling. Returns whether a listener consumed the
// scroll (preventDefault); the runtime then skips its native scrollport move
// so the two don't fight. Non-handling areas (file tree, chat) fall through
// to the runtime's scrollport scroll.
(globalThis as any).__cm_dispatch_wheel = (
  cmId: number,
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  x: number,
  y: number,
): boolean => {
  const target = nodeRegistry.get(cmId);
  if (!target) return false;
  const ev = new CarbonWheelEvent("wheel", {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    deltaX, deltaY, deltaMode: deltaMode | 0,
  });
  (ev as any).target = target;
  try { target.dispatchEvent(ev); } catch { /* swallow listener errors */ }
  return ev.defaultPrevented;
};

/** Look up a CarbonNode by its scene-graph cmId. Used by the click
 *  dispatcher and by frameworks that hold cmId references for HMR. */
const nodeRegistry = new Map<number, CarbonNode>();

// ─── Event ────────────────────────────────────────────────────────────────
// Tier-2 minimum: type, target, currentTarget, bubbles, cancelable,
// defaultPrevented, propagation flags. Synthesizes from carbon-mini events.

export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

export interface EventListener {
  (this: CarbonNode, event: CarbonEvent): void;
}

export class CarbonEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  defaultPrevented = false;
  target: CarbonNode | null = null;
  currentTarget: CarbonNode | null = null;
  _propagationStopped = false;
  _immediatePropagationStopped = false;
  timeStamp = Date.now();
  isTrusted = false;
  // Tier-2 stage constants
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;
  eventPhase = CarbonEvent.NONE;

  constructor(type: string, init?: EventInit) {
    this.type = type;
    this.bubbles = init?.bubbles ?? false;
    this.cancelable = init?.cancelable ?? false;
    this.composed = init?.composed ?? false;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this._propagationStopped = true;
  }
  stopImmediatePropagation(): void {
    this._propagationStopped = true;
    this._immediatePropagationStopped = true;
  }
  composedPath(): CarbonNode[] {
    const path: CarbonNode[] = [];
    let cur: CarbonNode | null = this.target;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    return path;
  }
}

export class CarbonMouseEvent extends CarbonEvent {
  clientX = 0;
  clientY = 0;
  pageX = 0;
  pageY = 0;
  screenX = 0;
  screenY = 0;
  button = 0;
  buttons = 0;
  shiftKey = false;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  detail = 0;
  constructor(type: string, init?: EventInit & { clientX?: number; clientY?: number; button?: number }) {
    super(type, init);
    this.clientX = init?.clientX ?? 0;
    this.clientY = init?.clientY ?? 0;
    this.button = init?.button ?? 0;
  }
}

// WheelEvent — carries scroll deltas. xterm.js (and any overflow scroller)
// reads `deltaY`/`deltaMode` off this and calls `preventDefault()` when it
// consumes the scroll; the runtime uses that to decide whether to also move
// a carbon scrollport (see the MouseWheel handler in main.rs).
export class CarbonWheelEvent extends CarbonMouseEvent {
  deltaX = 0;
  deltaY = 0;
  deltaZ = 0;
  // 0 = DOM_DELTA_PIXEL (the runtime always sends pixel deltas).
  deltaMode = 0;
  readonly DOM_DELTA_PIXEL = 0;
  readonly DOM_DELTA_LINE = 1;
  readonly DOM_DELTA_PAGE = 2;
  constructor(
    type: string,
    init?: EventInit & {
      clientX?: number; clientY?: number; button?: number;
      deltaX?: number; deltaY?: number; deltaZ?: number; deltaMode?: number;
    },
  ) {
    super(type, init);
    this.deltaX = init?.deltaX ?? 0;
    this.deltaY = init?.deltaY ?? 0;
    this.deltaZ = init?.deltaZ ?? 0;
    this.deltaMode = init?.deltaMode ?? 0;
  }
}

export class CarbonKeyboardEvent extends CarbonEvent {
  key = "";
  code = "";
  // keyCode/which are legacy but xterm.js (and many editors) branch on
  // them heavily for special keys (Enter=13, Backspace=8, arrows=37-40…),
  // so we populate them from the key name.
  keyCode = 0;
  which = 0;
  // charCode is the character code on `keypress` (0 on keydown/keyup). xterm
  // and other editors read it first when deriving the typed character.
  charCode = 0;
  location = 0;
  shiftKey = false;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  repeat = false;
  constructor(
    type: string,
    init?: EventInit & {
      key?: string;
      code?: string;
      keyCode?: number;
      which?: number;
      charCode?: number;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      repeat?: boolean;
    },
  ) {
    super(type, init);
    this.key = init?.key ?? "";
    this.code = init?.code ?? "";
    this.keyCode = init?.keyCode ?? 0;
    this.which = init?.which ?? init?.keyCode ?? 0;
    this.charCode = init?.charCode ?? 0;
    this.ctrlKey = init?.ctrlKey ?? false;
    this.shiftKey = init?.shiftKey ?? false;
    this.altKey = init?.altKey ?? false;
    this.metaKey = init?.metaKey ?? false;
    this.repeat = init?.repeat ?? false;
  }
  getModifierState(k: string): boolean {
    switch (k) {
      case "Control": return this.ctrlKey;
      case "Shift": return this.shiftKey;
      case "Alt": return this.altKey;
      case "Meta": return this.metaKey;
      default: return false;
    }
  }
}

// ─── Node base ────────────────────────────────────────────────────────────

export class CarbonNode {
  /** Scene-graph id assigned by the runtime. Stable for the node's lifetime. */
  cmId: number;
  nodeType: number;
  nodeName: string;
  parentNode: CarbonNode | null = null;
  childNodes: CarbonNode[] = [];
  ownerDocument: CarbonDocument | null = null;

  /** Listener map: type → Set<listener>. Lazy alloc. */
  protected _listeners?: Map<string, Set<EventListener>>;
  protected _captureListeners?: Map<string, Set<EventListener>>;

  constructor(nodeType: number, nodeName: string, tag: string) {
    this.cmId = nextNodeId();
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    __cm_create_node(this.cmId, tag, "{}");
    nodeRegistry.set(this.cmId, this);
  }

  get nodeValue(): string | null {
    return null;
  }
  set nodeValue(_v: string | null) {
    // Element nodes ignore nodeValue per spec; Text overrides.
  }

  get textContent(): string {
    let s = "";
    for (const c of this.childNodes) s += c.textContent ?? "";
    return s;
  }
  set textContent(v: string) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    if (v != null && v !== "") {
      const t = new CarbonText(String(v));
      this.appendChild(t);
    }
  }

  get firstChild(): CarbonNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): CarbonNode | null {
    return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null;
  }
  get nextSibling(): CarbonNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }
  get previousSibling(): CarbonNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i > 0 ? this.parentNode.childNodes[i - 1] : null;
  }
  get parentElement(): CarbonElement | null {
    let p = this.parentNode;
    while (p && p.nodeType !== ELEMENT_NODE) p = p.parentNode;
    return p as CarbonElement | null;
  }

  hasChildNodes(): boolean {
    return this.childNodes.length > 0;
  }

  contains(other: CarbonNode | null): boolean {
    let cur: CarbonNode | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  appendChild<T extends CarbonNode>(child: T): T {
    if ((child as CarbonNode) === this) throw new Error("HierarchyRequestError");
    if (child.parentNode) detachForMove(child);
    if (child.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const frag = child as unknown as CarbonDocumentFragment;
      const kids = frag.childNodes.slice();
      for (const k of kids) this.appendChild(k);
      return child;
    }
    this.childNodes.push(child);
    child.parentNode = this;
    __cm_insert_node(this.cmId, child.cmId, -1);
    if ((this as any).tagName === "STYLE" && child.nodeType === TEXT_NODE) {
      registerStylesheet((child as any).data ?? child.textContent ?? "", "style#" + this.cmId);
    } else if (hasStylesheets()) {
      applyStylesheetTo(child);
    }
    __cm_request_paint();
    return child;
  }

  insertBefore<T extends CarbonNode>(child: T, ref: CarbonNode | null): T {
    if (ref == null) return this.appendChild(child);
    if (ref.parentNode !== this) throw new Error("NotFoundError");
    if (child.parentNode) detachForMove(child);
    if (child.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const frag = child as unknown as CarbonDocumentFragment;
      const kids = frag.childNodes.slice();
      for (const k of kids) this.insertBefore(k, ref);
      return child;
    }
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    __cm_insert_node(this.cmId, child.cmId, ref.cmId);
    if ((this as any).tagName === "STYLE" && child.nodeType === TEXT_NODE) {
      registerStylesheet((child as any).data ?? child.textContent ?? "", "style#" + this.cmId);
    } else if (hasStylesheets()) {
      applyStylesheetTo(child);
    }
    __cm_request_paint();
    return child;
  }

  removeChild<T extends CarbonNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error("NotFoundError");
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    __cm_remove_node(child.cmId);
    nodeRegistry.delete(child.cmId);
    clickListeners.delete(child.cmId);
    __cm_request_paint();
    return child;
  }

  replaceChild<T extends CarbonNode>(newChild: CarbonNode, oldChild: T): T {
    this.insertBefore(newChild, oldChild);
    this.removeChild(oldChild);
    return oldChild;
  }

  /**
   * insertAdjacentElement — positions an element relative to this one. Radix's
   * FocusGuards inserts `[data-radix-focus-guard]` sentinels into document.body
   * via `body.insertAdjacentElement("afterbegin"|"beforeend", guard)`; without
   * this method that threw "not a function" and the Dialog/Dropdown/Tooltip
   * portal never finished mounting.
   */
  insertAdjacentElement(position: string, element: CarbonNode): CarbonNode | null {
    switch (position) {
      case "beforebegin":
        if (this.parentNode) (this.parentNode as CarbonElement).insertBefore(element, this);
        return element;
      case "afterbegin":
        this.insertBefore(element, this.firstChild);
        return element;
      case "beforeend":
        this.appendChild(element);
        return element;
      case "afterend":
        if (this.parentNode) (this.parentNode as CarbonElement).insertBefore(element, this.nextSibling);
        return element;
      default:
        return null;
    }
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  cloneNode(_deep?: boolean): CarbonNode {
    // Shallow stub — frameworks that clone nodes (template-based libs) get
    // a fresh node without children. Good enough for most React/Solid
    // patterns; real-deep-clone is a future enhancement.
    const clone = new CarbonElement((this as any).tagName ?? "view");
    clone.ownerDocument = this.ownerDocument;
    return clone;
  }

  // ── Events ─────────────────────────────────────────────────────────────
  addEventListener(
    type: string,
    listener: EventListener | { handleEvent: EventListener } | null,
    options?: boolean | { capture?: boolean; once?: boolean; passive?: boolean },
  ): void {
    if (!listener) return;
    const fn: EventListener = typeof listener === "function"
      ? listener
      : (e) => listener.handleEvent.call(this, e);
    const capture = typeof options === "boolean" ? options : options?.capture ?? false;
    const map = capture
      ? (this._captureListeners ??= new Map())
      : (this._listeners ??= new Map());
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(fn);
    // Click → mark scene-graph clickable so the runtime hit-test fires.
    if (type === "click" || type === "mousedown") {
      __cm_set_prop(this.cmId, "clickable", "true");
      let cset = clickListeners.get(this.cmId);
      if (!cset) { cset = new Set(); clickListeners.set(this.cmId, cset); }
      cset.add(fn);
    }
  }

  removeEventListener(
    type: string,
    listener: EventListener | { handleEvent: EventListener } | null,
    options?: boolean | { capture?: boolean },
  ): void {
    if (!listener) return;
    const fn: EventListener = typeof listener === "function" ? listener : (listener as any).handleEvent;
    const capture = typeof options === "boolean" ? options : options?.capture ?? false;
    const map = capture ? this._captureListeners : this._listeners;
    map?.get(type)?.delete(fn);
    if (type === "click" || type === "mousedown") {
      clickListeners.get(this.cmId)?.delete(fn);
    }
  }

  /** Dispatch with capture-then-bubble propagation. */
  dispatchEvent(event: CarbonEvent): boolean {
    const path: CarbonNode[] = [];
    let cur: CarbonNode | null = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    if (!event.target) event.target = this;

    // Capture phase (root → target, exclusive of target)
    event.eventPhase = CarbonEvent.CAPTURING_PHASE;
    for (let i = path.length - 1; i > 0; i--) {
      if (event._propagationStopped) break;
      const node = path[i];
      event.currentTarget = node;
      node._captureListeners?.get(event.type)?.forEach((fn) => {
        if (event._immediatePropagationStopped) return;
        try { fn.call(node, event); } catch (e) { console.error(e); }
      });
    }

    // Target phase. Per the DOM spec, at AT_TARGET BOTH the target's
    // capture-registered AND bubble-registered listeners fire (the capture
    // phase above is exclusive of the target). xterm.js registers its
    // keydown/focus listeners on the textarea with `capture: true`, so
    // without firing the target's capture listeners here, typing and focus
    // silently do nothing.
    if (!event._propagationStopped) {
      event.eventPhase = CarbonEvent.AT_TARGET;
      event.currentTarget = this;
      this._captureListeners?.get(event.type)?.forEach((fn) => {
        if (event._immediatePropagationStopped) return;
        try { fn.call(this, event); } catch (e) { console.error(e); }
      });
      this._listeners?.get(event.type)?.forEach((fn) => {
        if (event._immediatePropagationStopped) return;
        try { fn.call(this, event); } catch (e) { console.error(e); }
      });
    }

    // Bubble phase (target's parent → root)
    if (event.bubbles && !event._propagationStopped) {
      event.eventPhase = CarbonEvent.BUBBLING_PHASE;
      for (let i = 1; i < path.length; i++) {
        if (event._propagationStopped) break;
        const node = path[i];
        event.currentTarget = node;
        node._listeners?.get(event.type)?.forEach((fn) => {
          if (event._immediatePropagationStopped) return;
          try { fn.call(node, event); } catch (e) { console.error(e); }
        });
      }
    }

    event.eventPhase = CarbonEvent.NONE;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

// ─── Text ─────────────────────────────────────────────────────────────────

export class CarbonText extends CarbonNode {
  private _data: string;
  constructor(data: string) {
    super(TEXT_NODE, "#text", "text");
    this._data = String(data ?? "");
    __cm_set_text(this.cmId, this._data);
  }
  get data(): string { return this._data; }
  set data(v: string) {
    this._data = String(v);
    __cm_set_text(this.cmId, this._data);
    __cm_request_paint();
  }
  get nodeValue(): string { return this._data; }
  set nodeValue(v: string) { this.data = v; }
  get textContent(): string { return this._data; }
  set textContent(v: string) { this.data = v; }
  get length(): number { return this._data.length; }
  appendData(d: string): void { this.data = this._data + d; }
  splitText(_offset: number): CarbonText {
    const t = new CarbonText("");
    if (this.parentNode) this.parentNode.insertBefore(t, this.nextSibling);
    return t;
  }
}

export class CarbonComment extends CarbonNode {
  private _data: string;
  constructor(data = "") {
    super(COMMENT_NODE, "#comment", "comment");
    this._data = String(data);
  }
  get data(): string { return this._data; }
  set data(v: string) { this._data = String(v); }
  get nodeValue(): string { return this._data; }
  set nodeValue(v: string) { this.data = v; }
  get textContent(): string { return this._data; }
  set textContent(v: string) { this.data = v; }
}

export class CarbonDocumentFragment extends CarbonNode {
  constructor() {
    super(DOCUMENT_FRAGMENT_NODE, "#document-fragment", "view");
    // Note: we still create a scene-graph node for the fragment so that the
    // backing __cm_remove_node call has a target on cleanup. In practice
    // fragments are inserted (children dispersed into the parent) right
    // after creation so this node is rarely visible to the layout engine.
  }
}

// ─── classList ────────────────────────────────────────────────────────────

export class CarbonDOMTokenList {
  private el: CarbonElement;
  constructor(el: CarbonElement) {
    this.el = el;
  }
  private get tokens(): string[] {
    const cls = this.el.getAttribute("class") ?? "";
    return cls.split(/\s+/).filter(Boolean);
  }
  private save(tokens: string[]): void {
    this.el.setAttribute("class", tokens.join(" "));
  }
  add(...names: string[]): void {
    const toks = this.tokens;
    for (const n of names) if (!toks.includes(n)) toks.push(n);
    this.save(toks);
  }
  remove(...names: string[]): void {
    const toks = this.tokens.filter((t) => !names.includes(t));
    this.save(toks);
  }
  toggle(name: string, force?: boolean): boolean {
    const toks = this.tokens;
    const i = toks.indexOf(name);
    const has = i >= 0;
    const want = force == null ? !has : !!force;
    if (want && !has) toks.push(name);
    else if (!want && has) toks.splice(i, 1);
    this.save(toks);
    return want;
  }
  contains(name: string): boolean {
    return this.tokens.includes(name);
  }
  replace(oldName: string, newName: string): boolean {
    const toks = this.tokens;
    const i = toks.indexOf(oldName);
    if (i < 0) return false;
    toks[i] = newName;
    this.save(toks);
    return true;
  }
  get length(): number { return this.tokens.length; }
  item(i: number): string | null { return this.tokens[i] ?? null; }
  toString(): string { return this.tokens.join(" "); }
  *[Symbol.iterator](): IterableIterator<string> { yield* this.tokens; }
}

// ─── style (CSSStyleDeclaration via Proxy) ────────────────────────────────

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function createStyleProxy(el: CarbonElement): any {
  const store: Record<string, string> = {};
  const target = {
    setProperty(name: string, value: string): void {
      store[name] = String(value);
      if (name === "font-family" || name === "fontFamily") ensureSystemFont(String(value));
      __cm_set_prop(el.cmId, name, JSON.stringify(value));
      __cm_request_paint();
    },
    getPropertyValue(name: string): string {
      return store[name] ?? "";
    },
    removeProperty(name: string): string {
      const old = store[name] ?? "";
      delete store[name];
      __cm_set_prop(el.cmId, name, JSON.stringify(""));
      __cm_request_paint();
      return old;
    },
    get cssText(): string {
      return Object.entries(store).map(([k, v]) => `${camelToKebab(k)}: ${v}`).join("; ");
    },
    set cssText(v: string) {
      // Parse `prop: value; prop: value` declarations and apply each to the
      // scene. Many libraries (xterm, lit, hand-rolled widgets) set
      // `el.style.cssText = "..."` for one-shot styling; treating it as a
      // no-op silently dropped all their inline layout/colour. Values with
      // an embedded `;` (rare — data URIs) aren't supported; everything
      // else round-trips. Setting cssText replaces the whole declaration
      // block, so clear previously-applied props first.
      for (const k of Object.keys(store)) {
        __cm_set_prop(el.cmId, k, JSON.stringify(""));
        delete store[k];
      }
      if (typeof v === "string" && v.length) {
        for (const decl of v.split(";")) {
          const idx = decl.indexOf(":");
          if (idx < 0) continue;
          const name = decl.slice(0, idx).trim();
          if (!name) continue;
          const value = decl.slice(idx + 1).trim();
          store[name] = value;
          __cm_set_prop(el.cmId, name, JSON.stringify(value));
        }
      }
      __cm_request_paint();
    },
  } as any;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop in target) return (target as any)[prop];
      const k = String(prop);
      return store[k] ?? "";
    },
    set(_t, prop, value) {
      const k = String(prop);
      // The Proxy `set` trap fires for EVERY assignment, including
      // `style.cssText = "..."` — which must go through the parsing setter
      // on `target`, not be stored as a literal "cssText" scene prop. Without
      // this delegation the accessor below is dead code and all cssText
      // styling (xterm cells, etc.) silently vanishes.
      if (k === "cssText") {
        (target as { cssText: string }).cssText = String(value);
        return true;
      }
      store[k] = String(value);
      if (k === "fontFamily" || k === "font-family") ensureSystemFont(String(value));
      __cm_set_prop(el.cmId, k, JSON.stringify(value));
      __cm_request_paint();
      return true;
    },
  });
}

// ─── Element ──────────────────────────────────────────────────────────────

export class CarbonElement extends CarbonNode {
  tagName: string;
  attributes: Record<string, string> = {};
  /** HTMLElement.dataset — proxies `data-*` attributes. Code that writes
   *  `el.dataset.chrome = "borderless"` should hit setAttribute under
   *  the hood so the scene actually receives the attribute. */
  readonly dataset: Record<string, string>;
  private _style?: any;
  private _classList?: CarbonDOMTokenList;
  /** Free-form bag for framework-private fields ($$typeof, __reactFiber$xxx, etc.). */
  [key: string]: any;

  constructor(tagName: string | undefined | null) {
    // Defensive: React-DOM-shaped libraries occasionally pass undefined
    // for unknown tags. Default to "div" so we still produce a usable
    // element rather than crashing inside __cm_create_node's tag check.
    const safe = typeof tagName === "string" && tagName ? tagName : "div";
    super(ELEMENT_NODE, safe.toUpperCase(), safe);
    this.tagName = safe.toUpperCase();
    // Back the dataset with a Proxy so assignments fall through to
    // setAttribute (`data-<kebab-case-key>`).
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (target, key) => target[key as string],
      set: (target, key, value) => {
        const k = String(key);
        target[k] = String(value);
        // dataset.chromeBorderless → data-chrome-borderless (camelCase
        // splits on capitals).
        const attr = "data-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        this.setAttribute(attr, String(value));
        return true;
      },
      deleteProperty: (target, key) => {
        const k = String(key);
        delete target[k];
        const attr = "data-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        this.removeAttribute(attr);
        return true;
      },
    });
  }

  setAttribute(name: string, value: string): void {
    const v = String(value);
    this.attributes[name] = v;
    if (name === "class") {
      __cm_set_prop(this.cmId, "className", JSON.stringify(v));
    } else {
      __cm_set_prop(this.cmId, name, JSON.stringify(v));
    }
    // class / id changes can flip which stylesheet rules match.
    if ((name === "class" || name === "id") && hasStylesheets()) {
      applyStylesheetTo(this, false);
    }
    __cm_request_paint();
  }
  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
    __cm_set_prop(this.cmId, name, JSON.stringify(""));
    __cm_request_paint();
  }
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
  getAttributeNames(): string[] {
    return Object.keys(this.attributes);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const has = this.hasAttribute(name);
    const want = force == null ? !has : !!force;
    if (want && !has) this.setAttribute(name, "");
    else if (!want && has) this.removeAttribute(name);
    return want;
  }

  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", v); }

  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(v: string) { this.setAttribute("id", v); }

  get style(): any {
    return (this._style ??= createStyleProxy(this));
  }

  get classList(): CarbonDOMTokenList {
    return (this._classList ??= new CarbonDOMTokenList(this));
  }

  get children(): CarbonElement[] {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE) as CarbonElement[];
  }
  get firstElementChild(): CarbonElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): CarbonElement | null {
    const c = this.children;
    return c[c.length - 1] ?? null;
  }
  get childElementCount(): number { return this.children.length; }

  /** innerHTML is write-only-ish: we accept a tiny string payload (plain
   *  text or a single tag) and otherwise drop the request. Frameworks that
   *  *read* innerHTML get the empty string. Anything that needs real HTML
   *  parsing is out of scope for this shim. */
  get innerHTML(): string {
    return this.textContent;
  }
  set innerHTML(v: string) {
    this.textContent = String(v);
  }
  get outerHTML(): string {
    return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  // ── Layout reads ──────────────────────────────────────────────────────
  // Backed by the runtime's `__cm_layout_box` host import: triggers a
  // synchronous taffy layout pass against the current window
  // dimensions, then reads the node's computed absolute box. This is
  // what react-resizable-panels, framer-motion, and most measurement-
  // dependent libraries need to function. The host call is cheap —
  // taffy memoizes per dirty-flag and most queries hit a clean tree.
  getBoundingClientRect(): DOMRectLike {
    const r = readLayoutBox(this.cmId);
    return {
      x: r.x, y: r.y, width: r.w, height: r.h,
      top: r.y, left: r.x, right: r.x + r.w, bottom: r.y + r.h,
      toJSON() { return this; },
    };
  }
  get offsetWidth(): number { return readLayoutBox(this.cmId).w; }
  get offsetHeight(): number { return readLayoutBox(this.cmId).h; }
  get offsetLeft(): number { return readLayoutBox(this.cmId).x; }
  get offsetTop(): number { return readLayoutBox(this.cmId).y; }
  get clientWidth(): number { return readLayoutBox(this.cmId).w; }
  get clientHeight(): number { return readLayoutBox(this.cmId).h; }
  get clientLeft(): number { return 0; }
  get clientTop(): number { return 0; }
  get scrollWidth(): number { return readLayoutBox(this.cmId).w; }
  get scrollHeight(): number { return readLayoutBox(this.cmId).h; }
  // scrollTop is read/write. The setter routes to __cm_set_scroll_y so
  // overflow:auto containers (e.g. the terminal pane) can be auto-
  // scrolled to the live tail. Reading after writing returns the
  // clamped value if the runtime exposes a getter; otherwise the last
  // value the caller wrote (browsers don't clamp on read either —
  // they return what you set until layout reconciles).
  private _scrollTop = 0;
  get scrollTop(): number { return this._scrollTop; }
  set scrollTop(v: number) {
    this._scrollTop = v;
    const fn = (globalThis as unknown as {
      __cm_set_scroll_y?: (id: number, y: number) => void;
    }).__cm_set_scroll_y;
    if (typeof fn === "function") {
      try { fn(this.cmId, v); } catch { /* ignore */ }
    }
  }
  scrollLeft = 0;
  scrollIntoView(): void {
    // Approximation: scroll the element's nearest scrollport to the
    // top of this element. Without a real layout we just request the
    // element's parent to scroll a lot, letting clamping land us at
    // the right spot if the element is at the top, or at the bottom
    // if "end" / off-screen.
    this.scrollTop = 0;
  }
  scrollTo(): void {}
  scrollBy(): void {}

  // Web Animations API + pointer capture. Radix (Presence, Slider, Switch)
  // and Framer Motion probe these on portal/body-mounted refs; a missing
  // method throws "not a function" mid-mount. Inert, correctly-shaped stubs:
  // no running animations, no captured pointers.
  getAnimations(): unknown[] {
    return [];
  }
  animate(): {
    finished: Promise<void>;
    cancel(): void;
    finish(): void;
    play(): void;
    pause(): void;
    reverse(): void;
    addEventListener(): void;
    removeEventListener(): void;
    onfinish: unknown;
    oncancel: unknown;
    currentTime: number;
    playState: string;
  } {
    const noop = (): void => {};
    return {
      finished: Promise.resolve(),
      cancel: noop, finish: noop, play: noop, pause: noop, reverse: noop,
      addEventListener: noop, removeEventListener: noop,
      onfinish: null, oncancel: null, currentTime: 0, playState: "finished",
    };
  }
  hasPointerCapture(): boolean {
    return false;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  // Text-input selection API — no-ops (the scene input primitive doesn't
  // model a selection range yet). Present so rename/new-file inputs that
  // focus() then select()/setSelectionRange() don't throw mid-mount.
  select(): void {}
  setSelectionRange(): void {}
  setRangeText(): void {}

  // ── Focus management (no-ops) ─────────────────────────────────────────
  // Real focus tracking. document.activeElement follows focus()/blur() and
  // we fire focus/focusin (and blur/focusout on the previously-focused
  // element). xterm.js gates input + cursor on the focus state of its
  // hidden textarea — without this, clicking the terminal does nothing and
  // typing is ignored.
  focus(_opts?: { preventScroll?: boolean }): void {
    const doc = this.ownerDocument as any;
    if (!doc) return;
    const prev = doc.activeElement as CarbonElement | null;
    if (prev === (this as unknown as CarbonElement)) return;
    if (prev && prev !== (this as unknown as CarbonElement)) {
      try { prev.dispatchEvent(new CarbonEvent("blur", { bubbles: false })); } catch { /* noop */ }
      try { prev.dispatchEvent(new CarbonEvent("focusout", { bubbles: true })); } catch { /* noop */ }
    }
    doc.activeElement = this;
    try { this.dispatchEvent(new CarbonEvent("focus", { bubbles: false })); } catch { /* noop */ }
    try { this.dispatchEvent(new CarbonEvent("focusin", { bubbles: true })); } catch { /* noop */ }
    __cm_request_paint();
  }
  blur(): void {
    const doc = this.ownerDocument as any;
    if (!doc || doc.activeElement !== (this as unknown as CarbonElement)) return;
    doc.activeElement = doc.body ?? null;
    try { this.dispatchEvent(new CarbonEvent("blur", { bubbles: false })); } catch { /* noop */ }
    try { this.dispatchEvent(new CarbonEvent("focusout", { bubbles: true })); } catch { /* noop */ }
    __cm_request_paint();
  }

  // ── Query selectors — basic implementations ──────────────────────────
  // tag-only selectors (`view`, `text`) work; #id and .class are looked
  // up with a linear walk. Combinators / attribute selectors / pseudo-
  // classes are out of scope.
  querySelector(selector: string): CarbonElement | null {
    return querySelectorImpl(this, selector, false)[0] ?? null;
  }
  querySelectorAll(selector: string): CarbonElement[] {
    return querySelectorImpl(this, selector, true);
  }
  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }
  closest(selector: string): CarbonElement | null {
    let cur: CarbonElement | null = this;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * Modern visibility predicate (W3C CSSOM View). Radix's `useFloating`
   * / Floating UI's reference-tracking middleware call this before
   * positioning a popover — if we returned `false` (or threw because
   * it didn't exist) the popover wouldn't mount. We approximate: an
   * element is visible if it has a positive-area layout box and no
   * explicit `display: none` or `visibility: hidden` in props. Cheaper
   * than walking the full CSS cascade, and good enough for the libs
   * that gate on it.
   */
  checkVisibility(_opts?: {
    checkOpacity?: boolean;
    checkVisibilityCSS?: boolean;
    contentVisibilityAuto?: boolean;
    opacityProperty?: boolean;
    visibilityProperty?: boolean;
  }): boolean {
    const box = readLayoutBox(this.cmId);
    if (box.w <= 0 || box.h <= 0) return false;
    const style = (this as unknown as { style?: { display?: string; visibility?: string } }).style;
    if (style?.display === "none") return false;
    if (style?.visibility === "hidden") return false;
    return true;
  }

  /**
   * One DOMRect per fragment of the element's layout box. We don't
   * model line boxes / multi-fragment text, so a single rect from
   * `getBoundingClientRect()` is the correct (and only) answer.
   * Floating UI's `getElementRects` / `useFloating` collision middleware
   * uses this — without it positioning silently bails out.
   */
  getClientRects(): DOMRectLike[] {
    return [this.getBoundingClientRect()];
  }

  /**
   * Root-of-tree lookup. Radix's Portal uses this to decide where to
   * mount content (default target = `getRootNode()`). For light DOM
   * we return the owner document; we have no shadow DOM concept, so
   * the `composed` flag is meaningless here.
   */
  getRootNode(_opts?: { composed?: boolean }): CarbonNode {
    let cur: CarbonNode = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur;
  }

  /**
   * DOM tree relationship bitmask. Floating UI / Radix call this to
   * test whether the focused element is inside the popover content
   * (preventing click-outside dismissal of its own click).
   *
   *   DOCUMENT_POSITION_DISCONNECTED       = 0x01
   *   DOCUMENT_POSITION_PRECEDING          = 0x02
   *   DOCUMENT_POSITION_FOLLOWING          = 0x04
   *   DOCUMENT_POSITION_CONTAINS           = 0x08
   *   DOCUMENT_POSITION_CONTAINED_BY       = 0x10
   */
  compareDocumentPosition(other: CarbonNode): number {
    if (other === this) return 0;
    // Walk other's ancestor chain looking for `this`.
    for (let p: CarbonNode | null = other.parentNode; p; p = p.parentNode) {
      if (p === this) return 0x10 | 0x04; // CONTAINED_BY | FOLLOWING
    }
    // Walk this's ancestor chain looking for `other`.
    for (let p: CarbonNode | null = this.parentNode; p; p = p.parentNode) {
      if (p === other) return 0x08 | 0x02; // CONTAINS | PRECEDING
    }
    // Find common ancestor and decide ordering by child index.
    const ancestors = (n: CarbonNode | null) => {
      const out: CarbonNode[] = [];
      for (let c = n; c; c = c.parentNode) out.unshift(c);
      return out;
    };
    const a = ancestors(this);
    const b = ancestors(other);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === 0) return 0x01; // disconnected — different roots
    const ca = a[i - 1];
    const ai = ca.childNodes.indexOf(a[i] ?? this);
    const bi = ca.childNodes.indexOf(b[i] ?? other);
    return ai < bi ? 0x04 : 0x02; // FOLLOWING : PRECEDING
  }
}

interface DOMRectLike {
  x: number; y: number; width: number; height: number;
  top: number; left: number; right: number; bottom: number;
  toJSON(): DOMRectLike;
}

// ─── Selector helpers (Tier-1 minimum) ────────────────────────────────────

function matchesSelector(el: CarbonElement, selector: string): boolean {
  selector = selector.trim();
  if (!selector) return false;
  if (selector === "*") return true;
  if (selector.startsWith("#")) return el.id === selector.slice(1);
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function querySelectorImpl(
  root: CarbonElement,
  selector: string,
  all: boolean,
): CarbonElement[] {
  const results: CarbonElement[] = [];
  const stack: CarbonElement[] = root.children.slice();
  while (stack.length) {
    const el = stack.shift()!;
    if (matchesSelector(el, selector)) {
      results.push(el);
      if (!all) return results;
    }
    stack.unshift(...el.children);
  }
  return results;
}

// ─── Document ─────────────────────────────────────────────────────────────

const ROOT_ID = 1;
let rootInstalled = false;

// ─── TreeWalker (document.createTreeWalker) ───────────────────────────────
// Radix UI's focus-scope walks the DOM with a TreeWalker + NodeFilter to find
// tabbable elements for focus trapping (Dialog / Popover / DropdownMenu). The
// shim lacked both, so opening any of them threw "NodeFilter is not defined".
// We implement the standard depth-first walk. Children come from EITHER
// `childNodes` (@carbon/compat-dom nodes) or `children` (@carbon/mini-react
// nodes) since a portal's content subtree is the latter.
function twChildren(n: any): any[] {
  if (!n) return [];
  if (Array.isArray(n.childNodes) && n.childNodes.length) return n.childNodes;
  if (Array.isArray(n.children)) return n.children;
  if (Array.isArray(n.childNodes)) return n.childNodes;
  return [];
}
function twParent(n: any): any { return n ? (n.parentNode ?? n.parent ?? null) : null; }
function twSiblingAfter(n: any): any {
  const p = twParent(n);
  if (!p) return null;
  const kids = twChildren(p);
  const i = kids.indexOf(n);
  return i >= 0 ? (kids[i + 1] ?? null) : null;
}
function twSiblingBefore(n: any): any {
  const p = twParent(n);
  if (!p) return null;
  const kids = twChildren(p);
  const i = kids.indexOf(n);
  return i > 0 ? kids[i - 1] : null;
}

export class CarbonTreeWalker {
  root: any;
  whatToShow: number;
  filter: any;
  currentNode: any;
  constructor(root: any, whatToShow = 0xffffffff, filter: any = null) {
    this.root = root;
    this.whatToShow = whatToShow >>> 0;
    this.filter = filter;
    this.currentNode = root;
  }
  private accept(node: any): number {
    const nt = (node && typeof node.nodeType === "number") ? node.nodeType : 1;
    const bit = 1 << (nt - 1);
    if ((this.whatToShow & bit) === 0) return 3; // FILTER_SKIP
    const f = this.filter;
    let res: number = 1; // FILTER_ACCEPT
    try {
      if (typeof f === "function") res = f(node);
      else if (f && typeof f.acceptNode === "function") res = f.acceptNode(node);
    } catch { res = 1; }
    return res == null ? 1 : res;
  }
  firstChild(): any {
    const kids = twChildren(this.currentNode);
    for (const k of kids) {
      const r = this.accept(k);
      if (r === 1) { this.currentNode = k; return k; }
      if (r === 3) {
        const save = this.currentNode; this.currentNode = k;
        const deep = this.firstChild();
        if (deep) return deep;
        this.currentNode = save;
      }
    }
    return null;
  }
  parentNode(): any {
    let n = twParent(this.currentNode);
    while (n && n !== twParent(this.root)) {
      if (this.accept(n) === 1) { this.currentNode = n; return n; }
      n = twParent(n);
    }
    return null;
  }
  nextSibling(): any {
    let n = twSiblingAfter(this.currentNode);
    while (n) {
      const r = this.accept(n);
      if (r === 1) { this.currentNode = n; return n; }
      n = twSiblingAfter(n);
    }
    return null;
  }
  previousSibling(): any {
    let n = twSiblingBefore(this.currentNode);
    while (n) {
      const r = this.accept(n);
      if (r === 1) { this.currentNode = n; return n; }
      n = twSiblingBefore(n);
    }
    return null;
  }
  nextNode(): any {
    let node = this.currentNode;
    let result = 1;
    for (;;) {
      // Descend into children unless the current branch was rejected.
      while (result !== 2) {
        const kids = twChildren(node);
        if (!kids.length) break;
        node = kids[0];
        result = this.accept(node);
        if (result === 1) { this.currentNode = node; return node; }
      }
      // Move to the next sibling, ascending until we find one (or hit root).
      let following: any = null;
      let temp: any = node;
      while (temp && temp !== this.root) {
        following = twSiblingAfter(temp);
        if (following) break;
        temp = twParent(temp);
      }
      if (!following) return null;
      node = following;
      result = this.accept(node);
      if (result === 1) { this.currentNode = node; return node; }
    }
  }
  previousNode(): any {
    let node = this.currentNode;
    while (node !== this.root) {
      let sibling = twSiblingBefore(node);
      while (sibling) {
        node = sibling;
        let r = this.accept(node);
        let kids = twChildren(node);
        while (r !== 2 && kids.length) {
          node = kids[kids.length - 1];
          r = this.accept(node);
          kids = twChildren(node);
        }
        if (r === 1) { this.currentNode = node; return node; }
        sibling = twSiblingBefore(node);
      }
      const parent = twParent(node);
      if (!parent || parent === twParent(this.root)) return null;
      node = parent;
      if (this.accept(node) === 1) { this.currentNode = node; return node; }
    }
    return null;
  }
}

export class CarbonDocument extends CarbonNode {
  documentElement: CarbonElement;
  body: CarbonElement;
  head: CarbonElement;
  defaultView: any = null;
  readyState = "complete";
  visibilityState = "visible";
  hidden = false;
  title = "carbon-mini";
  /** Currently focused element (CSSOM `document.activeElement`). Updated by
   *  CarbonElement.focus()/blur(); read by libraries (and our keydown
   *  bridge) to route keyboard input. Defaults to <body>. */
  activeElement: CarbonElement | null = null;

  constructor() {
    super(DOCUMENT_NODE, "#document", "view");
    this.ownerDocument = this;
    this.documentElement = new CarbonElement("html");
    this.documentElement.ownerDocument = this;
    this.head = new CarbonElement("head");
    this.body = new CarbonElement("body");
    this.head.ownerDocument = this;
    this.body.ownerDocument = this;
    this.activeElement = this.body;
    // Root install: body becomes the carbon-mini scene root (id=1) so
    // frameworks that mount into document.body land in the right place.
    if (!rootInstalled) {
      // Re-id body to the canonical ROOT_ID and tell the runtime.
      __cm_remove_node(this.body.cmId);
      nodeRegistry.delete(this.body.cmId);
      this.body.cmId = ROOT_ID;
      __cm_create_node(ROOT_ID, "view", "{}");
      __cm_set_root(ROOT_ID);
      nodeRegistry.set(ROOT_ID, this.body);
      rootInstalled = true;
    }
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    // Make the document the root of the parentNode chain so events
    // dispatched on a focused element bubble all the way up to `document`
    // listeners (window.addEventListener('keydown', …) lands there). Set
    // directly (not via appendChild — document isn't a scene node).
    (this.documentElement as CarbonNode).parentNode = this;
    // Seed the conventional React mount point. Apps coming from Vite +
    // index.html assume `<div id="root">` is already in the body — our
    // bundle eval has no index.html, so we synthesise the same shape
    // here. Without this `ReactDOM.createRoot(getElementById("root"))`
    // hands React a null container and the reconciler immediately
    // crashes with "TypeError: not a function".
    const rootDiv = new CarbonElement("div");
    rootDiv.id = "root";
    rootDiv.ownerDocument = this;
    this.body.appendChild(rootDiv);
  }

  createElement(tagName: string): CarbonElement {
    const el = new CarbonElement(tagName);
    el.ownerDocument = this;
    const lower = typeof tagName === "string" ? tagName.toLowerCase() : "";
    if (lower === "canvas") {
      attachCanvas(el);
    } else if (lower === "style") {
      // <style> is non-visual (hidden), and its CSS is fed to the stylesheet
      // engine so author rules (e.g. xterm's injected scrollbar/dimension
      // rules) actually apply to scene nodes. Intercept textContent so we
      // capture the CSS and never create a visible text child.
      __cm_set_prop(el.cmId, "display", JSON.stringify("none"));
      let cssText = "";
      const styleSourceKey = "style#" + el.cmId;
      Object.defineProperty(el, "textContent", {
        configurable: true,
        get(): string { return cssText; },
        set(v: string) { cssText = String(v ?? ""); registerStylesheet(cssText, styleSourceKey); },
      });
      // Libraries that use el.appendChild(document.createTextNode(css)) or
      // el.sheet.insertRule still work: a fake sheet captures insertRule.
      (el as any).sheet = {
        cssRules: [] as any[],
        get length() { return (this.cssRules as any[]).length; },
        insertRule(rule: string, index?: number) {
          registerStylesheet(rule);
          const i = index ?? (this.cssRules as any[]).length;
          (this.cssRules as any[]).splice(i, 0, { cssText: rule });
          return i;
        },
        deleteRule() {},
      };
    } else if (NON_VISUAL_TAGS.has(lower)) {
      // <style>/<script>/<head>/… carry no visual content. Libraries like
      // xterm.js inject a <style> element whose textContent is CSS; without
      // this it would paint as literal text in the scene. Mark the node
      // display:none so the runtime skips layout + paint of it and its
      // (text) children. The element still lives in the DOM tree for any
      // JS that reads `.textContent` / `.sheet`.
      __cm_set_prop(el.cmId, "display", JSON.stringify("none"));
    }
    return el;
  }
  createElementNS(_ns: string, tagName: string): CarbonElement {
    return this.createElement(tagName);
  }
  createTextNode(data: string): CarbonText {
    const t = new CarbonText(data);
    t.ownerDocument = this;
    return t;
  }
  createComment(data: string): CarbonComment {
    const c = new CarbonComment(data);
    c.ownerDocument = this;
    return c;
  }
  createDocumentFragment(): CarbonDocumentFragment {
    const f = new CarbonDocumentFragment();
    f.ownerDocument = this;
    return f;
  }
  createTreeWalker(root: any, whatToShow = 0xffffffff, filter: any = null): CarbonTreeWalker {
    return new CarbonTreeWalker(root, whatToShow, filter);
  }
  getElementById(id: string): CarbonElement | null {
    return querySelectorImpl(this.body, "#" + id, false)[0] ?? null;
  }
  querySelector(selector: string): CarbonElement | null {
    if (selector === "body") return this.body;
    if (selector === "html") return this.documentElement;
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector: string): CarbonElement[] {
    return this.body.querySelectorAll(selector);
  }
  getElementsByTagName(tag: string): CarbonElement[] {
    return querySelectorImpl(this.body, tag, true);
  }
  getElementsByClassName(cls: string): CarbonElement[] {
    return querySelectorImpl(this.body, "." + cls, true);
  }
  // Range / Selection. CodeMirror's EditorView measures text by creating a
  // Range over character nodes and reading its client rects, and syncs its
  // internal selection through window.getSelection(). Both were absent, so
  // the editor threw "document.createRange is not a function" during mount
  // and the pane's ErrorBoundary showed an error on every file open. These
  // are shaped, non-throwing implementations: measurement approximates via
  // the range's nearest element box (cursor/selection geometry is coarse,
  // but the file renders instead of erroring), and the selection is inert.
  createRange(): CarbonRange { return new CarbonRange(); }
  getSelection(): CarbonSelection { return sharedSelection; }
  // No-op visual stubs frameworks sometimes call.
  exitFullscreen(): Promise<void> { return Promise.resolve(); }
  hasFocus(): boolean { return true; }
}

// Minimal Range — enough for CodeMirror's DOM measurement to run without
// throwing. Geometry falls back to the nearest element's box (per-glyph
// precision would need a JS↔text-engine bridge; not modelled yet).
export class CarbonRange {
  startContainer: any = null;
  endContainer: any = null;
  startOffset = 0;
  endOffset = 0;
  collapsed = true;
  get commonAncestorContainer(): any { return this.startContainer; }
  setStart(node: any, offset: number): void { this.startContainer = node; this.startOffset = offset | 0; this._sync(); }
  setEnd(node: any, offset: number): void { this.endContainer = node; this.endOffset = offset | 0; this._sync(); }
  setStartBefore(node: any): void { this.setStart(node?.parentNode ?? node, 0); }
  setStartAfter(node: any): void { this.setStart(node?.parentNode ?? node, 0); }
  setEndBefore(node: any): void { this.setEnd(node?.parentNode ?? node, 0); }
  setEndAfter(node: any): void { this.setEnd(node?.parentNode ?? node, 0); }
  selectNode(node: any): void { this.startContainer = this.endContainer = node?.parentNode ?? node; this.collapsed = false; }
  selectNodeContents(node: any): void { this.startContainer = this.endContainer = node; this.collapsed = false; }
  collapse(toStart?: boolean): void {
    if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
    else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    this.collapsed = true;
  }
  private _sync(): void {
    this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }
  cloneRange(): CarbonRange {
    const r = new CarbonRange();
    r.startContainer = this.startContainer; r.endContainer = this.endContainer;
    r.startOffset = this.startOffset; r.endOffset = this.endOffset; r.collapsed = this.collapsed;
    return r;
  }
  cloneContents(): CarbonDocumentFragment { return new CarbonDocumentFragment(); }
  extractContents(): CarbonDocumentFragment { return new CarbonDocumentFragment(); }
  deleteContents(): void {}
  insertNode(node: any): void { try { this.startContainer?.appendChild?.(node); } catch { /* ignore */ } }
  surroundContents(): void {}
  comparePoint(): number { return 0; }
  compareBoundaryPoints(): number { return 0; }
  isPointInRange(): boolean { return false; }
  intersectsNode(): boolean { return false; }
  detach(): void {}
  toString(): string { return ""; }
  /** Nearest element to measure — text nodes have no box of their own. */
  private _measureEl(): any {
    let n = this.startContainer;
    while (n && n.nodeType !== ELEMENT_NODE) n = n.parentNode;
    return n;
  }
  getBoundingClientRect(): DOMRectLike {
    const el = this._measureEl();
    if (el && typeof el.getBoundingClientRect === "function") return el.getBoundingClientRect();
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() { return this; } };
  }
  getClientRects(): DOMRectLike[] {
    const r = this.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? [r] : [];
  }
  createContextualFragment(): CarbonDocumentFragment { return new CarbonDocumentFragment(); }
}

// Inert Selection — CodeMirror reads/writes it to mirror the DOM caret. We
// report an empty, collapsed selection and accept writes as no-ops; the
// scene input primitive owns real caret state elsewhere.
export class CarbonSelection {
  rangeCount = 0;
  type = "None";
  anchorNode: any = null;
  anchorOffset = 0;
  focusNode: any = null;
  focusOffset = 0;
  isCollapsed = true;
  private _range: CarbonRange | null = null;
  getRangeAt(_i: number): CarbonRange { return this._range ?? new CarbonRange(); }
  addRange(r: CarbonRange): void { this._range = r; this.rangeCount = 1; }
  removeAllRanges(): void { this._range = null; this.rangeCount = 0; }
  empty(): void { this.removeAllRanges(); }
  collapse(node: any, offset = 0): void { this.anchorNode = this.focusNode = node; this.anchorOffset = this.focusOffset = offset; }
  collapseToStart(): void {}
  collapseToEnd(): void {}
  extend(node: any, offset = 0): void { this.focusNode = node; this.focusOffset = offset; }
  setBaseAndExtent(a: any, ao: number, f: any, fo: number): void {
    this.anchorNode = a; this.anchorOffset = ao; this.focusNode = f; this.focusOffset = fo;
  }
  selectAllChildren(): void {}
  containsNode(): boolean { return false; }
  toString(): string { return ""; }
}
const sharedSelection = new CarbonSelection();

// Reference type aliases for ergonomics (mirrors the WHATWG names).
export type CarbonElementType = CarbonElement;
export type CarbonTextType = CarbonText;

export { ROOT_ID, nodeRegistry, clickListeners };
