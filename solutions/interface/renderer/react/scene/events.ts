// The Rust→JS event surface, and the React `on*` props it feeds.
//
// The `flush-sync` import is load-bearing rather than decorative: it installs
// the accessor traps that wrap every dispatcher in flushSync + a paint
// request, and the assignments below must go THROUGH those traps. Importing
// it here is what guarantees it evaluated first.

import "../host/imports.ts";
import "../reconciler/flush-sync.ts";
import { nodeRegistry, type CmNode } from "./node.ts";

export const clickHandlers = new Map<number, (e: ClickEvent) => void>();
export const inputHandlers = new Map<number, (e: any) => void>();

// Pointer / mouse / key / focus handlers wired from React `on*` props,
// keyed by scene-node id → DOM event type → handler. Radix (menus, selects,
// popovers, tooltips) opens its triggers on `onPointerDown` / `onKeyDown`,
// never `onClick`; before this those props were silently dropped by
// applyProps, so every dropdown was dead. The `__cm_dispatch_pointer`
// override installed below fires these for React host nodes.
export const eventHandlers = new Map<number, Map<string, (e: any) => void>>();

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
}

// Rust hit-test path → eval → this dispatcher → React click handler.
// The setter trap in flush-sync wraps the function we assign here in
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
// dispatcher trap wraps this in flushSync so state set inside a handler
// (e.g. Radix's onOpenToggle) commits + paints synchronously.
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
