// The scene node — the unit Solid mutates.

import "../host/imports.ts";

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

export const nodeTexts = new Map<number, string>();

export function freshNode(tag: string, isText = false): CmNode {
  const id = nextNodeId();
  __cm_create_node(id, tag, "{}");
  return { id, tag, parent: null, children: [], isText };
}
