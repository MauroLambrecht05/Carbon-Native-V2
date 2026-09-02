// The Rust→JS event surface, and the React `on*` props it feeds.
//
// The `flush-sync` import is load-bearing rather than decorative: it installs
// the accessor traps that wrap every dispatcher in flushSync + a paint
// request, and the assignments below must go THROUGH those traps. Importing
// it here is what guarantees it evaluated first.

import "../host/imports.ts";
import "../reconciler/flush-sync.ts";
import { nodeRegistry, type CmNode } from "./node.ts";

// Cached on globalThis — see node.ts's identical comment on nodeTexts/
// nodeRegistry for the full reasoning. Same failure mode here specifically:
// this module reassigns __cm_dispatch_click below on every reload (a
// module-level side effect, since events.ts is part of the APP half of a
// split build and re-evaluates every save), so a plain `new Map()` for
// clickHandlers would mean the dispatcher installed by THIS reload looks
// up a Map the cached reconciler's still-first-pass-bound createInstance/
// applyProps never writes into — every click after a reload silently finds
// nothing, no error, the handler is just in a different Map than the one
// __cm_dispatch_click reads.
const g = globalThis as unknown as {
  __cm_click_handlers?: Map<number, (e: ClickEvent) => void>;
  __cm_input_handlers?: Map<number, (e: any) => void>;
  __cm_event_handlers?: Map<number, Map<string, (e: any) => void>>;
};
export const clickHandlers = (g.__cm_click_handlers ??= new Map<number, (e: ClickEvent) => void>());
export const inputHandlers = (g.__cm_input_handlers ??= new Map<number, (e: any) => void>());

// Pointer / mouse / key / focus handlers wired from React `on*` props,
// keyed by scene-node id → DOM event type → handler. Radix (menus, selects,
// popovers, tooltips) opens its triggers on `onPointerDown` / `onKeyDown`,
// never `onClick`; before this those props were silently dropped by
// applyProps, so every dropdown was dead. The `__cm_dispatch_pointer`
// override installed below fires these for React host nodes.
export const eventHandlers = (g.__cm_event_handlers ??= new Map<number, Map<string, (e: any) => void>>());

// React `on*` prop → DOM event type. Only the interaction events the runtime
// actually delivers are wired; anything else (onScroll, onWheel,
// onAnimationEnd, …) still no-ops as before.
export const EVENT_PROP_TO_DOM: Record<string, string> = {
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
export const CLICKABLE_EVENTS = new Set(["pointerdown", "pointerup", "mousedown", "mouseup"]);

export interface ClickEvent {
  id: number;
  target: CmNode | null;
  currentTarget: CmNode | null;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

// Rust hit-test path → eval → this dispatcher → React click handler.
// The setter trap in flush-sync wraps the function we assign here in
// `flushSync` + `__cm_request_paint()`, so we just invoke the handler
// — committed state and paint both happen automatically.
//
// `chain` is the hit node's id followed by every ancestor up to the
// root (Rust's `Scene::ancestor_chain`, deepest-first) — real DOM
// bubbling. Previously this only ever received the single hit id, so
// `<div onClick={A}><button onClick={B}/></div>` fired B alone; A
// (a container-level delegated handler, a common React pattern) never
// ran. A bare number is still accepted for direct in-process callers
// (dom-facade.ts's `ref.current.click()`) that have no ancestor chain
// to walk — those don't bubble, matching a synthetic single-node click.
(globalThis as any).__cm_dispatch_click = (chain: number | number[]) => {
  const ids = Array.isArray(chain) ? chain : [chain];
  if (ids.length === 0) return;
  const target = nodeRegistry.get(ids[0]) ?? null;
  let stopped = false;
  for (const id of ids) {
    if (stopped) break;
    const handler = clickHandlers.get(id);
    if (!handler) continue;
    const event: ClickEvent = {
      id,
      target,
      currentTarget: nodeRegistry.get(id) ?? null,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; },
    };
    try { handler(event); }
    catch (e) { (globalThis as any).console?.error?.("[react-mini] click handler threw:", e); }
  }
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
// dispatcher trap wraps this in flushSync so state set inside a handler
// (e.g. Radix's onOpenToggle) commits + paints synchronously.
{
  const g = globalThis as any;
  const prevDispatchPointer = g.__cm_dispatch_pointer;
  // Chain to whatever was there before — EXCEPT our own previous reload's
  // wrapper. This block re-runs every reload (module-level side effect,
  // same as the dispatchers above), so without this guard each reload
  // would wrap the last, and once eventHandlers stopped being a fresh Map
  // every pass (see this file's top comment), every accumulated layer
  // would find the SAME real handler and fire it once each — a pointerdown
  // after three reloads would run its handler three times. The one thing
  // still worth chaining to is @carbon/compat-dom's dispatcher for its own
  // (non-React) nodes, which is never one of these.
  const chainTo = typeof prevDispatchPointer === "function" && prevDispatchPointer.__cmIsPointerDispatch
    ? undefined
    : prevDispatchPointer;
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
  // `cmIds` is the hit node's id followed by every ancestor up to the root
  // (deepest-first) for down/up — real bubbling, same reasoning as
  // `__cm_dispatch_click` above (Radix opens triggers on `onPointerDown`,
  // so a delegated container-level listener needs this exactly as much as
  // onClick does). `move` still only ever receives a single id (Rust's
  // move-repeat path wasn't converted to a chain — high-frequency, lower
  // stakes for the delegation pattern) — a bare number is accepted for
  // that case and for any other single-id caller.
  g.__cm_dispatch_pointer = (
    cmIds: number | number[], phase: string, x: number, y: number, button: number,
  ) => {
    const ids = Array.isArray(cmIds) ? cmIds : [cmIds];
    const types = phase === "down" ? ["pointerdown", "mousedown"]
      : phase === "up" ? ["pointerup", "mouseup"]
      : phase === "move" ? ["pointermove", "mousemove"]
      : [];
    if (ids.length > 0 && types.length > 0) {
      const target = nodeRegistry.get(ids[0]) ?? null;
      let stopped = false;
      outer: for (const id of ids) {
        if (stopped) break;
        const handlers = eventHandlers.get(id);
        if (!handlers) continue;
        const node = nodeRegistry.get(id) ?? null;
        for (const t of types) {
          const fn = handlers.get(t);
          if (typeof fn !== "function") continue;
          const ev = makePointerEvent(t, node, x, y, button);
          ev.target = target;
          const realStop = ev.stopPropagation;
          const realStopImm = ev.stopImmediatePropagation;
          ev.stopPropagation = () => { stopped = true; realStop(); };
          ev.stopImmediatePropagation = () => { stopped = true; realStopImm(); };
          try { fn(ev); }
          catch (e) { (globalThis as any).console?.error?.("[react-mini] pointer handler threw:", e); }
          if (stopped) break outer;
        }
      }
    }
    // Chain to the DOM-shim dispatcher so its own nodes (xterm focus, portal
    // refs) still receive the press. No-ops for React ids it doesn't know.
    // Uses the original (deepest) id only — the shim has its own,
    // separate bubbling (node.ts's real capture/bubble dispatchEvent).
    if (typeof chainTo === "function" && ids.length > 0) {
      try { chainTo(ids[0], phase, x, y, button); } catch { /* ignore */ }
    }
  };
  g.__cm_dispatch_pointer.__cmIsPointerDispatch = true;
}
