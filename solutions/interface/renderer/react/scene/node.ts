// The scene node — what a fiber commits to.

import "../host/imports.ts";
import { getRoot } from "./root.ts";

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

// Cached on globalThis, not a plain module-level `new Map()` — the same
// reason render.ts caches the reconciler container there. host-config.ts's
// reconciler is constructed ONCE and reused across every `carbon dev`
// reload (that's what lets React Fast Refresh keep fiber/hook state alive);
// its createInstance/commitUpdate/etc. methods are closures captured at
// THAT first construction, permanently bound to whatever `nodeTexts` this
// module exported at the time. If this were a fresh Map every reload (this
// file is part of the APP half of a split build, re-evaluated every save —
// see render.ts's own comment on why), the cached reconciler would go on
// writing into the FIRST reload's Map forever, while anything that reads a
// FRESH import of `nodeTexts` after a later reload — including this file's
// own module-level re-run — would see a permanently empty one. Reproduced
// directly: a debug hook reading `nodeTexts` right after a reload found it
// empty despite the window visibly showing text, because the write and the
// read were going through two different Map instances.
const g = globalThis as unknown as {
  __cm_node_texts?: Map<number, string>;
  __cm_node_registry?: Map<number, CmNode>;
};
export const nodeTexts = (g.__cm_node_texts ??= new Map<number, string>());

// id → CmNode, so a dispatched synthetic event can carry the real node as
// its target/currentTarget and so the dispatcher can tell a React host node
// from a @carbon/compat-dom node (which the DOM-shim dispatcher owns).
export const nodeRegistry = (g.__cm_node_registry ??= new Map<number, CmNode>());

/**
 * Resolve a node's *scene* id. React host nodes (CmNode) carry a numeric
 * `.id`; @carbon/compat-dom nodes (e.g. `document.body`, a Radix portal target)
 * carry `.cmId` and use `.id` for the HTML id attribute (a string). The
 * reconciler's container ops can receive EITHER (portals mount into
 * document.body), so passing `.id` blindly hands the runtime a string where it
 * wants an f64 ("Error converting from js 'string' into type 'f64'"). Always
 * go through this so the right numeric scene id reaches `__cm_insert_node`.
 */
export function sceneIdOf(n: any): number {
  if (n && typeof n.cmId === "number") return n.cmId;
  if (n && typeof n.id === "number") return n.id;
  return getRoot().id;
}

export function freshNode(tag: string | undefined | null, isText = false): CmNode {
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
