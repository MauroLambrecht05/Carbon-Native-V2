// HMR support.

import { canvasReadyHandlers } from "../intrinsics/canvas.ts";
import {
  clickHandlers,
  pointerDownHandlers,
  pointerMoveHandlers,
  pointerUpHandlers,
} from "../scene/events.ts";
import { nodeTexts } from "../scene/node.ts";
import { resetRoot } from "../scene/root.ts";
import { activeTweens, lastAppliedValues, transitionConfig } from "../scene/transitions.ts";
import {
  contextMenuListeners,
  fileDragListeners,
  focusListeners,
  keydownListeners,
  themeListeners,
} from "./app-events.ts";
import { disposeMounted } from "./mount.ts";

// ─── HMR support ─────────────────────────────────────────────────────────
// The Rust runtime calls globalThis.__cm_hmr_reset() before re-eval'ing
// a new bundle. We tear down all module-level state that depends on
// scene-node identity (root, click handlers, ID counter) so the next
// mount() builds a clean tree. The __hmr_state Map is intentionally NOT
// cleared — that's where createPersistentSignal stashes signal values
// across reloads. The whole point of this is to survive there.
(globalThis as any).__cm_hmr_reset = () => {
  disposeMounted();
  resetRoot();
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

export {};
