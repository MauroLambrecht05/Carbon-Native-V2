// The event surface: what the runtime dispatches at a node, and the handler
// maps the renderer's setProperty path registers into.

import "../host/imports.ts";
import type { CmNode } from "./node.ts";
import { currentRoot } from "./root.ts";

export const clickHandlers = new Map<number, (e: ClickEvent) => void>();
export const pointerDownHandlers = new Map<number, (e: PointerEvent) => void>();
export const pointerMoveHandlers = new Map<number, (e: PointerEvent) => void>();
export const pointerUpHandlers = new Map<number, (e: PointerEvent) => void>();

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
  let cur = findLive(currentRoot(), startId);
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

export function hasAnyPointerHandler(id: number): boolean {
  return (
    pointerDownHandlers.has(id) ||
    pointerMoveHandlers.has(id) ||
    pointerUpHandlers.has(id)
  );
}

export function registerPointerHandler(
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
