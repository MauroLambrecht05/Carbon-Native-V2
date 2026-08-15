// The scene root — the one node this renderer does not create on demand.
//
// Separate from node.ts because it is state, not a factory: the root is
// allocated once, `__cm_set_root` is told about it once, and HMR resets it.

import "../host/imports.ts";
import type { CmNode } from "./node.ts";

const ROOT_ID = 1;
let rootNode: CmNode | null = null;

export function getRoot(): CmNode {
  if (!rootNode) {
    // Root view fills the window AND lays out children in a column so
    // app-level `h-screen flex-col` containers behave as expected. The
    // React-DOM convention is that <body> is full-height with no
    // intrinsic layout — but our scene doesn't expose that automatic
    // window-sizing through CSS, so we wire it explicitly.
    __cm_create_node(
      ROOT_ID,
      "view",
      JSON.stringify({
        width: "100%",
        height: "100%",
        "flex-direction": "column",
      }),
    );
    __cm_set_root(ROOT_ID);
    rootNode = { id: ROOT_ID, tag: "view", isText: false, parent: null, children: [] };
  }
  return rootNode;
}

/** The root as it stands, WITHOUT creating one. The test API and HMR want
 *  this — asking about a tree that was never mounted should answer null,
 *  not allocate a scene node as a side effect of the question. */
export function currentRoot(): CmNode | null {
  return rootNode;
}

/** HMR: drop the root so the next getRoot() rebuilds it. */
export function resetRoot(): void {
  rootNode = null;
}
