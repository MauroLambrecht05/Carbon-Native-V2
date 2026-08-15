// The scene root — allocated once, reset by HMR.

import "../host/imports.ts";
import type { CmNode } from "./node.ts";

// ─── Convenience: mount a component into the runtime's pre-allocated root ─
// The runtime creates a root node with id=1 lazily on first __cm_set_root call.
const ROOT_ID = 1;
let rootNode: CmNode | null = null;

export function getRoot(): CmNode {
  if (!rootNode) {
    __cm_create_node(ROOT_ID, "view", "{}");
    __cm_set_root(ROOT_ID);
    rootNode = { id: ROOT_ID, tag: "view", parent: null, children: [], isText: false };
  }
  return rootNode;
}

/** The root as it stands, WITHOUT creating one. The test API and the
 *  ancestor walk want this: asking about a tree that was never mounted
 *  should answer null, not allocate a scene node as a side effect. */
export function currentRoot(): CmNode | null {
  return rootNode;
}

/** HMR: drop the root so the next getRoot() rebuilds it. */
export function resetRoot(): void {
  rootNode = null;
}
