// HMR — survives bundle re-eval, the same way interface/renderer/solid does.
//
// The dev server re-evaluates the whole bundle in the live JS context. Every
// map in this package is module state keyed by scene-node id, and the scene
// those ids point at is gone, so a reset that misses one leaves handlers
// firing against nodes the runtime has already dropped.

import { clickHandlers, eventHandlers, inputHandlers } from "../scene/events.ts";
import { nodeRegistry, nodeTexts } from "../scene/node.ts";
import { resetRoot } from "../scene/root.ts";
import { unmountRoot } from "./render.ts";

(globalThis as any).__cm_hmr_reset = () => {
  unmountRoot();
  resetRoot();
  clickHandlers.clear();
  inputHandlers.clear();
  nodeTexts.clear();
  eventHandlers.clear();
  nodeRegistry.clear();
};

export {};
