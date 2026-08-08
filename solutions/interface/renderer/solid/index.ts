// @carbon/mini-solid — Solid universal renderer wired into the carbon-mini
// scene-graph host imports. Configured to be the `moduleName` for
// vite-plugin-solid's universal preset:
//
//   solid({ solid: { generate: 'universal', moduleName: '@carbon/mini-solid' } })
//
// The plugin then emits JSX as calls to the renderer functions exported here.

import { createRenderer } from "solid-js/universal";
import { createEffect, createSignal, createRoot, onCleanup } from "solid-js";

// ─── Host imports declared by carbon/runtime/mini.rs ──────────────────
// These are bound globals exposed by the runtime; no DOM, no IPC envelope.
declare const __cm_create_node: (id: number, tag: string, propsJson: string) => void;
declare const __cm_set_text: (id: number, text: string) => void;
declare const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
declare const __cm_insert_node: (parentId: number, childId: number, beforeId: number) => void;
declare const __cm_remove_node: (id: number) => void;
declare const __cm_set_root: (id: number) => void;
declare const __cm_request_paint: () => void;
// GPU canvas host imports — bound by the runtime in main.rs::register_host_imports.
// Lazy: the wgpu device is constructed on the FIRST __carbon_canvas_create
// call. UI-only apps never trigger GPU init.
declare const __carbon_canvas_create: (width: number, height: number) => number;
declare const __carbon_canvas_resize: (id: number, width: number, height: number) => void;
declare const __carbon_canvas_clear: (id: number, r: number, g: number, b: number, a: number) => void;
declare const __carbon_canvas_destroy: (id: number) => void;

// ─── Scene node — the unit Solid mutates ─────────────────────────────────
export interface CmNode {
  id: number;
  tag: string;
  parent: CmNode | null;
  children: CmNode[];
  isText: boolean;
  /** Set on `<canvas>` intrinsics. Lazily initialized when width+height
   *  arrive on the node — that's when we ask Rust to create a wgpu
   *  surface. Stored back into props so the rasterizer can find it. */
  canvasId?: number;
  /** Last applied canvas pixel size. Tracked so we can call resize
   *  instead of recreating when only one of {width, height} changes. */
  canvasW?: number;
  canvasH?: number;
}

// Shared, process-wide node-id allocator — see the long note in
// @carbon/compat-dom/src/node.ts. All adapters that emit scene nodes draw ids
// from this single globalThis counter so co-resident adapters never collide
// in the shared Rust scene map. The counter is monotonic and never reset
// (including across --dev HMR), which also avoids collisions with stale
// references — see the reset hook below.
function nextNodeId(): number {
  const g = globalThis as { __cm_node_id_seq?: number };
  const next = (typeof g.__cm_node_id_seq === "number" ? g.__cm_node_id_seq : 99) + 1;
  g.__cm_node_id_seq = next;
  return next;
}
const clickHandlers = new Map<number, (e: ClickEvent) => void>();
const pointerDownHandlers = new Map<number, (e: PointerEvent) => void>();
const pointerMoveHandlers = new Map<number, (e: PointerEvent) => void>();
const pointerUpHandlers = new Map<number, (e: PointerEvent) => void>();
const nodeTexts = new Map<number, string>();

export interface ClickEvent {
  id: number;
}

export interface PointerEvent {
  id: number;
  /** "down" | "move" | "up" — the gesture phase. */
  type: "down" | "move" | "up";
  /** Window-space coordinates in CSS pixels. */
  clientX: number;
  clientY: number;
  /** 0 = left, 1 = middle, 2 = right. carbon-mini wires left button only. */
  button: number;
}

// Exposed to Rust hit-testing path: when a node is clicked, the runtime
// evaluates `globalThis.__cm_dispatch_click(<node-id>)`, which lands here.
(globalThis as any).__cm_dispatch_click = (id: number) => {
  const handler = clickHandlers.get(id);
  if (handler) {
    handler({ id });
    __cm_request_paint();
  }
};

// Walks up from `startId` to the nearest ancestor in `map`. Mirrors
// findClickableAncestor but works against any handler map — keeps the
// JS-side gesture routing in lock-step with hit-test ancestor walks.
function findAncestorIn(startId: number, map: Map<number, unknown>): number | null {
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
    if (map.has(cur.id)) return cur.id;
    cur = cur.parent;
  }
  return null;
}

// Pointer dispatcher. main.rs calls this on every left-button press,
// pointer-move-while-held, and release with the original-down node id.
// We walk up to the nearest handler (so an onMouseDown on a parent fires
// when a child gets the press), then synthesize a single event object.
(globalThis as any).__cm_dispatch_pointer = (
  id: number,
  kind: "down" | "move" | "up",
  x: number,
  y: number,
  button: number
) => {
  const map =
    kind === "down" ? pointerDownHandlers :
    kind === "move" ? pointerMoveHandlers :
    pointerUpHandlers;
  const target = map.has(id) ? id : findAncestorIn(id, map);
  if (target == null) return;
  const handler = map.get(target)!;
  handler({ id: target, type: kind, clientX: x, clientY: y, button });
  __cm_request_paint();
};

function hasAnyPointerHandler(id: number): boolean {
  return (
    pointerDownHandlers.has(id) ||
    pointerMoveHandlers.has(id) ||
    pointerUpHandlers.has(id)
  );
}

function registerPointerHandler(
  id: number,
  map: Map<number, (e: PointerEvent) => void>,
  value: any
) {
  if (typeof value === "function") {
    map.set(id, value);
    // Mark the node clickable so the Rust-side hit-test catches it.
    // We don't tag it "pointer-only" — anything that wants pointer
    // events participates in the same hit-test as click handlers.
    __cm_set_prop(id, "clickable", "true");
  } else {
    map.delete(id);
    // Only clear `clickable` if no other handler (click or pointer)
    // remains on this node.
    if (!clickHandlers.has(id) && !hasAnyPointerHandler(id)) {
      __cm_set_prop(id, "clickable", "false");
    }
  }
}

function freshNode(tag: string, isText = false): CmNode {
  const id = nextNodeId();
  __cm_create_node(id, tag, "{}");
  return { id, tag, parent: null, children: [], isText };
}

// ─── Canvas intrinsic plumbing ────────────────────────────────────────────
//
// The <canvas> intrinsic creates a Rust-side wgpu surface lazily — only
// when both width AND height are known on the JS-side node. That keeps
// the lazy-init contract: a UI-only app that never instantiates a
// <canvas> never triggers wgpu device construction.
//
// onReady gets called once per surface lifetime with `{ id }`. Phase 1
// callers issue draw commands by passing this id to
// __carbon_canvas_clear etc. directly. Phase 2's three.js renderer will
// instead consume the id internally.
const canvasReadyHandlers = new Map<number, (info: { id: number }) => void>();

function ensureCanvasSurface(node: CmNode) {
  // Need a real width AND height before we can ask wgpu for a texture.
  if (node.canvasW == null || node.canvasH == null) return;
  if (node.canvasId != null) return;
  const id = __carbon_canvas_create(node.canvasW, node.canvasH);
  if (!id || id <= 0) return; // GPU init failed; node stays inert.
  node.canvasId = id;
  // Persist the id on the scene node so the rasterizer can find the
  // matching wgpu surface during paint.
  __cm_set_prop(node.id, "canvas_id", String(id));
  const onReady = canvasReadyHandlers.get(node.id);
  if (onReady) onReady({ id });
}

// ─── Renderer: maps Solid's universal API onto our scene-graph host imports
const renderer = createRenderer<CmNode>({
  createElement(tag: string): CmNode {
    return freshNode(tag);
  },
  createTextNode(value: string): CmNode {
    const n = freshNode("text", true);
    const strValue = String(value);
    __cm_set_text(n.id, strValue);
    nodeTexts.set(n.id, strValue);
    return n;
  },
  replaceText(textNode: CmNode, value: string) {
    const strValue = String(value);
    __cm_set_text(textNode.id, strValue);
    nodeTexts.set(textNode.id, strValue);
    __cm_request_paint();
  },
  setProperty(node: CmNode, name: string, value: any) {
    // ── Canvas-specific props ──────────────────────────────────────
    // These intercepts fire for <canvas> nodes only; for everything
    // else they fall through to the generic setProperty path below.
    if (node.tag === "canvas") {
      if (name === "width" || name === "height") {
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n) && n > 0) {
          if (name === "width") node.canvasW = Math.round(n);
          else node.canvasH = Math.round(n);
          if (node.canvasId == null) {
            ensureCanvasSurface(node);
          } else if (node.canvasW != null && node.canvasH != null) {
            __carbon_canvas_resize(node.canvasId, node.canvasW, node.canvasH);
          }
          // Forward width/height to the scene node so taffy lays out the box.
          __cm_set_prop(node.id, name, String(name === "width" ? node.canvasW : node.canvasH));
          __cm_request_paint();
        }
        return;
      }
      // onReady({ id }): runs once when the wgpu surface is created.
      // The user uses `id` to call __carbon_canvas_clear etc. directly.
      if (name === "onReady") {
        if (typeof value === "function") {
          canvasReadyHandlers.set(node.id, value as any);
          // If the surface was already created (props came in a different
          // order), fire immediately.
          if (node.canvasId != null) {
            try { (value as any)({ id: node.canvasId }); } catch {}
          }
        } else {
          canvasReadyHandlers.delete(node.id);
        }
        return;
      }
      // ref={(el) => ...} — pass the CmNode (with `canvasId` set, if
      // available). Solid will call this synchronously during render.
      if (name === "ref") {
        if (typeof value === "function") {
          try { value(node); } catch {}
        }
        return;
      }
    }

    // Style: spread each rule as a separate scene prop.
    if (name === "style" && value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (key === "transition") {
          transitionConfig.set(node.id, parseTransition(String(value[key])));
          continue;
        }
        if (maybeStartTransition(node, key, value[key])) {
          recordAppliedValue(node.id, key, value[key]);
          continue;
        }
        __cm_set_prop(node.id, key, JSON.stringify(value[key]));
        recordAppliedValue(node.id, key, value[key]);
      }
      __cm_request_paint();
      return;
    }
    // Standalone `transition` prop on the node — store it without
    // forwarding to the scene (carbon-mini doesn't paint anything for
    // the prop itself; it only triggers tweens on subsequent sets).
    if (name === "transition") {
      transitionConfig.set(node.id, parseTransition(String(value)));
      return;
    }
    // Click: register handler + mark node clickable for hit-testing.
    if (name === "onClick" || name === "onclick") {
      if (typeof value === "function") {
        clickHandlers.set(node.id, value);
        __cm_set_prop(node.id, "clickable", "true");
      } else {
        clickHandlers.delete(node.id);
        if (!hasAnyPointerHandler(node.id)) {
          __cm_set_prop(node.id, "clickable", "false");
        }
      }
      return;
    }
    // Pointer events: onMouseDown / onMouseMove / onMouseUp.
    // We also flip the node `clickable` so it participates in hit-testing
    // — the Rust side dispatches based on the hit-test result, so without
    // this an onMouseDown-only node would never receive events.
    if (
      name === "onMouseDown" || name === "onmousedown" ||
      name === "onPointerDown" || name === "onpointerdown"
    ) {
      registerPointerHandler(node.id, pointerDownHandlers, value);
      return;
    }
    if (
      name === "onMouseMove" || name === "onmousemove" ||
      name === "onPointerMove" || name === "onpointermove"
    ) {
      registerPointerHandler(node.id, pointerMoveHandlers, value);
      return;
    }
    if (
      name === "onMouseUp" || name === "onmouseup" ||
      name === "onPointerUp" || name === "onpointerup"
    ) {
      registerPointerHandler(node.id, pointerUpHandlers, value);
      return;
    }
    // class — Tailwind plugin compiles to inline style; if a raw class string
    // arrives at runtime we just stash it as a prop for now (future: lookup
    // table). Doesn't crash; just won't visually apply.
    if (name === "class" || name === "className") {
      __cm_set_prop(node.id, "className", JSON.stringify(value));
      return;
    }
    // Animatable prop with an active transition spec — tween instead
    // of writing the new value immediately. Falls through to the
    // direct write otherwise.
    if (maybeStartTransition(node, name, value)) {
      recordAppliedValue(node.id, name, value);
      return;
    }
    // Generic: stringify the value and forward.
    __cm_set_prop(node.id, name, JSON.stringify(value));
    recordAppliedValue(node.id, name, value);
    __cm_request_paint();
  },
  insertNode(parent: CmNode, node: CmNode, anchor?: CmNode) {
    if (node.parent) {
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
    }
    node.parent = parent;
    if (anchor) {
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
      __cm_insert_node(parent.id, node.id, anchor.id);
    } else {
      parent.children.push(node);
      __cm_insert_node(parent.id, node.id, -1);
    }
    __cm_request_paint();
  },
  isTextNode(node: CmNode): boolean {
    return node.isText;
  },
  removeNode(parent: CmNode, node: CmNode) {
    const i = parent.children.indexOf(node);
    if (i >= 0) parent.children.splice(i, 1);
    node.parent = null;
    // Tear down the wgpu surface if this was a <canvas> intrinsic.
    if (node.tag === "canvas" && node.canvasId != null) {
      __carbon_canvas_destroy(node.canvasId);
      node.canvasId = undefined;
    }
    canvasReadyHandlers.delete(node.id);
    __cm_remove_node(node.id);
    __cm_request_paint();
  },
  getParentNode(node: CmNode): CmNode | undefined {
    return node.parent ?? undefined;
  },
  getFirstChild(node: CmNode): CmNode | undefined {
    return node.children[0];
  },
  getNextSibling(node: CmNode): CmNode | undefined {
    if (!node.parent) return undefined;
    const i = node.parent.children.indexOf(node);
    return node.parent.children[i + 1];
  },
});

// ─── Public API: vite-plugin-solid emits JSX as calls to these names ─────
// Re-exporting from the renderer object — same identities Solid's compiler expects.
// (Solid's universal renderer exports `setProp`, not `setProperty`. We pass our
// `setProperty` config option to createRenderer; the renderer wraps it as `setProp`.)
export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = renderer as any;

// ─── Convenience: mount a component into the runtime's pre-allocated root ─
// The runtime creates a root node with id=1 lazily on first __cm_set_root call.
const ROOT_ID = 1;
let rootNode: CmNode | null = null;

function getRoot(): CmNode {
  if (!rootNode) {
    __cm_create_node(ROOT_ID, "view", "{}");
    __cm_set_root(ROOT_ID);
    rootNode = { id: ROOT_ID, tag: "view", parent: null, children: [], isText: false };
  }
  return rootNode;
}

// Tracks Solid's dispose handle for the most recent mount. Used by HMR
// teardown so reloads dispose the previous owner tree (and its effects)
// before constructing a new one.
let lastDispose: (() => void) | null = null;

/** Mount a component as the root of the scene graph. */
export function mount(component: () => any): void {
  // Track the dispose handle returned by Solid's render() so HMR reloads
  // can tear down the previous reactive owner tree before mounting the
  // new one. Without this, signals from the old component graph keep
  // their effects alive — when the new bundle re-creates them under
  // (presumably) different node IDs, the stale effects fire against
  // dead scene nodes and we get phantom paints / leaks.
  if (lastDispose) {
    try { lastDispose(); } catch {}
    lastDispose = null;
  }
  lastDispose = render(component, getRoot());
  __cm_request_paint();
}

// ─── HMR support ─────────────────────────────────────────────────────────
// The Rust runtime calls globalThis.__cm_hmr_reset() before re-eval'ing
// a new bundle. We tear down all module-level state that depends on
// scene-node identity (root, click handlers, ID counter) so the next
// mount() builds a clean tree. The __hmr_state Map is intentionally NOT
// cleared — that's where createPersistentSignal stashes signal values
// across reloads. The whole point of this is to survive there.
(globalThis as any).__cm_hmr_reset = () => {
  if (lastDispose) {
    try { lastDispose(); } catch {}
    lastDispose = null;
  }
  rootNode = null;
  clickHandlers.clear();
  pointerDownHandlers.clear();
  pointerMoveHandlers.clear();
  pointerUpHandlers.clear();
  fileDragListeners.clear();
  keydownListeners.clear();
  themeListeners.clear();
  focusListeners.clear();
  contextMenuListeners.clear();
  canvasReadyHandlers.clear();
  nodeTexts.clear();
  transitionConfig.clear();
  lastAppliedValues.clear();
  activeTweens.clear();
  // Note: we don't enumerate-and-destroy live canvas surfaces here. The
  // Rust-side scene reset_for_hmr() drops the scene-graph references to
  // them, but the wgpu surfaces themselves stay in gpu::registry until
  // the new bundle's <canvas> intrinsics replace them. This is fine for
  // dev: the leak is bounded and bytecount-tiny per surface. A full
  // sweep would cost more than it gains.
  // Don't reset nextId — IDs are node identifiers, and keeping them
  // monotonic avoids any chance of collision with stale references.
  // (The Rust scene is wiped fully via reset_for_hmr() before we land here.)
};

/**
 * Like Solid's `createSignal`, but the value is stashed in a global
 * `__hmr_state` Map keyed by `key` and restored across `--dev` HMR
 * reloads. Because the Rust runtime keeps the rquickjs context alive
 * across re-eval, this Map literally survives in the same JS heap —
 * so the new component's first read sees the previous value with no
 * disk hop, no serialization, no flash-of-stale state.
 *
 * Usage:
 *   const [count, setCount] = createPersistentSignal("counter.count", 0);
 *
 * Limitations (v1):
 *   - User must supply a stable key per signal. Future v2 lifts this
 *     via a Babel transform that auto-keys every createSignal call by
 *     (file, function name, signal-call index).
 *   - Stash values must be structurally cloneable — for v1 the only
 *     real constraint is "no functions, no scene-node refs". Numbers,
 *     strings, plain objects, and arrays all work.
 */
export function createPersistentSignal<T>(key: string, initial: T) {
  const stash: Map<string, unknown> =
    ((globalThis as any).__hmr_state ??= new Map());
  const restored = stash.has(key) ? (stash.get(key) as T) : initial;
  const [value, setValue] = createSignal<T>(restored);
  // Mirror every set into the stash. createEffect runs eagerly once,
  // so the initial value lands in the stash on first mount too — that
  // way the first reload-after-startup also restores cleanly even if
  // the user never called setValue.
  createEffect(() => {
    stash.set(key, value());
  });
  return [value, setValue] as const;
}

// Also export createEffect + createSignal from solid-js for convenience.
// Apps re-export from here so users have a single import.
export { createEffect, createSignal };

// ─── Window + system theme + context menu events ────────────────────────

const themeListeners = new Set<(theme: "light" | "dark") => void>();
(globalThis as any).__cm_dispatch_theme_changed = (theme: string) => {
  const t = theme === "dark" ? "dark" : "light";
  for (const cb of themeListeners) {
    try { cb(t); } catch (_) {}
  }
};
export function onThemeChange(cb: (theme: "light" | "dark") => void): () => void {
  themeListeners.add(cb);
  return () => { themeListeners.delete(cb); };
}

const focusListeners = new Set<(focused: boolean) => void>();
(globalThis as any).__cm_dispatch_window_focus = (focused: boolean) => {
  for (const cb of focusListeners) {
    try { cb(focused); } catch (_) {}
  }
};
export function onWindowFocus(cb: (focused: boolean) => void): () => void {
  focusListeners.add(cb);
  return () => { focusListeners.delete(cb); };
}

export interface ContextMenuEvent {
  /** Hit-tested node id at the cursor, or null if no clickable hit. */
  id: number | null;
  /** Window-space x/y of the right-click in CSS pixels. */
  x: number;
  y: number;
}
const contextMenuListeners = new Set<(e: ContextMenuEvent) => void>();
(globalThis as any).__cm_dispatch_context_menu = (id: number | null, x: number, y: number) => {
  const evt: ContextMenuEvent = { id, x, y };
  for (const cb of contextMenuListeners) {
    try { cb(evt); } catch (_) {}
  }
};
export function onContextMenu(cb: (e: ContextMenuEvent) => void): () => void {
  contextMenuListeners.add(cb);
  return () => { contextMenuListeners.delete(cb); };
}

// ─── App-level keydown ───────────────────────────────────────────────────
//
// Apps register listeners via `onKeyDown(cb)` and receive every key
// press (whether or not an input is focused). The Rust side still
// routes the same event to the focused input/textarea afterwards, so
// shortcut handlers don't have to compete for ownership — they're
// purely additive. Typical use: cmd/ctrl chord shortcuts, escape to
// close modals, '?' to open help.

export interface CarbonKeyEvent {
  /** Logical key name. Letters/digits arrive lowercase ("a", "1");
   *  named keys use the W3C-ish label ("Enter", "Escape", "ArrowLeft",
   *  "F1"…). For unknown keys the Debug-format of tao's enum is used. */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Super / Command / Windows key. */
  meta: boolean;
}

const keydownListeners = new Set<(e: CarbonKeyEvent) => void>();

(globalThis as any).__cm_dispatch_keydown = (
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  meta: boolean,
) => {
  const evt: CarbonKeyEvent = { key, ctrl, shift, alt, meta };
  for (const cb of keydownListeners) {
    try { cb(evt); } catch (_) {}
  }
};

/** Register a global keydown listener. Returns an unsubscribe. */
export function onKeyDown(cb: (e: CarbonKeyEvent) => void): () => void {
  keydownListeners.add(cb);
  return () => { keydownListeners.delete(cb); };
}

// ─── OS file drag-and-drop ───────────────────────────────────────────────
//
// The Rust runtime forwards `WindowEvent::HoveredFile` / `DroppedFile`
// / `HoveredFileCancelled` via `__cm_dispatch_file_drag(kind, path)`.
// We collect registered listeners and fan out, mimicking the
// browser's `addEventListener('drop', ...)` registration model.
//
// `kind` is `"enter" | "leave" | "drop"`. `path` is the absolute file
// path on enter/drop, and null on leave. Apps that want a "session
// complete" signal can debounce inside the listener — tao fires one
// event per file, all in the same event-loop tick.
export interface FileDragEvent {
  kind: "enter" | "leave" | "drop";
  path: string | null;
}

const fileDragListeners = new Set<(e: FileDragEvent) => void>();

(globalThis as any).__cm_dispatch_file_drag = (kind: string, path: string | null) => {
  const evt: FileDragEvent = {
    kind: kind as FileDragEvent["kind"],
    path,
  };
  for (const cb of fileDragListeners) {
    try { cb(evt); } catch (_) {}
  }
};

/**
 * Register a listener for OS-level file drag-and-drop events fired
 * onto the window. Returns an unsubscribe function.
 *
 * ```ts
 * import { onFileDrag } from "@carbon/mini-solid";
 * const off = onFileDrag(e => {
 *   if (e.kind === "drop") console.log("dropped:", e.path);
 * });
 * // later: off();
 * ```
 */
export function onFileDrag(cb: (e: FileDragEvent) => void): () => void {
  fileDragListeners.add(cb);
  return () => { fileDragListeners.delete(cb); };
}

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

const transitionConfig = new Map<number, Map<string, TransitionSpec>>();
/** Map of propName → last applied value, used as the tween's `from`
 *  on the next set. Keyed by node id then prop name. */
const lastAppliedValues = new Map<number, Map<string, any>>();
const activeTweens = new Map<string, ActiveTween>();
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
function parseTransition(value: string): Map<string, TransitionSpec> {
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
function maybeStartTransition(node: CmNode, name: string, value: any): boolean {
  if (!ANIMATABLE_PROPS.has(name)) return false;
  const spec = getTransitionFor(node.id, name);
  if (!spec) return false;
  const lastMap = lastAppliedValues.get(node.id);
  const from = lastMap?.get(name);
  if (from === undefined || from === value) return false;
  return startTween(node, name, from, value, spec);
}

function recordAppliedValue(nodeId: number, name: string, value: any) {
  let m = lastAppliedValues.get(nodeId);
  if (!m) { m = new Map(); lastAppliedValues.set(nodeId, m); }
  m.set(name, value);
}

// ─── createPortal ────────────────────────────────────────────────────────
//
// Renders a child into a different parent in the scene graph. The
// canonical use is overlays — modals, tooltips, dropdowns, toasts —
// that visually escape their containing element's overflow / clip
// box. Without portals, anything painted by a deeply-nested component
// is bounded by its ancestors' overflow:hidden + z-index stacking,
// which is the wrong layout for floating UI.
//
// Implementation: spawn a Solid sub-tree under `createRoot` rooted at
// `target` (defaults to the scene root). Cleanup is tied to the
// calling component's owner via `onCleanup`, so portals dispose when
// the host component unmounts — no manual teardown required.
//
// Usage:
//   <view>
//     <button onClick={() => setOpen(true)}>Open</button>
//     {open() && createPortal(() => (
//       <view style={{ position: "absolute", top: "20%", left: "30%" }}>
//         Modal content
//       </view>
//     ))}
//   </view>
export function createPortal(
  component: () => any,
  target?: CmNode
): null {
  const portalParent = target ?? getRoot();
  let dispose: (() => void) | null = null;
  createRoot((d) => {
    dispose = d;
    (insert as any)(portalParent, component);
  });
  onCleanup(() => {
    if (dispose) {
      try { dispose(); } catch (_) {}
      dispose = null;
    }
  });
  // Nothing rendered at the call site — the portal owns its own sub-tree.
  return null;
}

// `@CarbonApp` is a custom carbon-mini directive (NOT a TypeScript
// decorator). Both the build pipeline and the @carbon/ts-plugin
// strip the line and inject a mount call before either tool parses
// the file — so there's nothing to expose at runtime. The user just
// writes:
//
//   @CarbonApp
//   function App() { return <view>...</view>; }
//
// …and it Just Works in their editor and at build time.

// Polyfills (performance, setTimeout, process, crypto stub) live in
// polyfills.ts. Apps that use NPM packages should `import
// "@carbon/mini-solid/polyfills"` as their FIRST import so the polyfills
// run before package module-init code touches them.

// ─── Testing API: AI-navigable scene inspection ──────────────────────────
// Install __cm_test global with methods to query, navigate, and inspect
// the rendered scene tree. Used by automated tests and AI agents.
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
  const nodeText = nodeTexts.get(node.id);
  if (nodeText === text) {
    results.push(serializeNodeTree(node));
  }
  node.children.forEach(child => findNodesByText(child, text, results));
  return results;
}

function findNodesByTag(node: CmNode | null, tag: string, results: TestNode[] = []): TestNode[] {
  if (!node) return results;
  if (node.tag === tag) {
    results.push(serializeNodeTree(node));
  }
  node.children.forEach(child => findNodesByTag(child, tag, results));
  return results;
}

// Walk up parent chain to find the nearest clickable ancestor (text nodes
// don't carry click handlers — their parent view does).
function findClickableAncestor(startId: number): number | null {
  // Walk the live CmNode tree (not the serialized one) to follow .parent.
  function walk(n: CmNode | null): CmNode | null {
    if (!n) return null;
    if (clickHandlers.has(n.id)) return n;
    return null;
  }
  // Find the live node by id, then walk up.
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
  findByText(text: string): TestNode[] {
    return findNodesByText(rootNode, text);
  },

  findByTag(tag: string): TestNode[] {
    return findNodesByTag(rootNode, tag);
  },

  dump(): string {
    return JSON.stringify(rootNode ? serializeNodeTree(rootNode) : null);
  },

  clickId(id: number): void {
    // If the node itself isn't clickable, walk up to find a clickable
    // ancestor — matches what the runtime's hit-test would find.
    const target = clickHandlers.has(id) ? id : findClickableAncestor(id);
    if (target != null) {
      (globalThis as any).__cm_dispatch_click?.(target);
      __cm_request_paint();
    }
  },

  clickText(text: string): void {
    const nodes = findNodesByText(rootNode, text);
    if (nodes.length > 0) {
      this.clickId(nodes[0].id);
    }
  },

  signals(): Record<string, unknown> {
    const stash = (globalThis as any).__hmr_state;
    if (!stash) return {};
    return Object.fromEntries(stash);
  },

  triggerPaint(): void {
    __cm_request_paint();
  },
};
