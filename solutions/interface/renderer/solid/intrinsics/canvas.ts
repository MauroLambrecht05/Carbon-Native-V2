// The <canvas> intrinsic's Rust-side surface.

import "../host/imports.ts";
import type { CmNode } from "../scene/node.ts";

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
export const canvasReadyHandlers = new Map<number, (info: { id: number }) => void>();

export function ensureCanvasSurface(node: CmNode) {
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
