// @carbon/mini-solid — Solid universal renderer wired into the carbon-mini
// scene-graph host imports. Configured to be the `moduleName` for
// vite-plugin-solid's universal preset:
//
//   solid({ solid: { generate: 'universal', moduleName: '@carbon/mini-solid' } })
//
// The plugin then emits JSX as calls to the renderer functions exported here.
//
// ── LAYOUT ──────────────────────────────────────────────────────────────────
//   host/         the eleven host imports this renderer sits on
//   scene/        what Solid mutates — the node, the root, the event surface,
//                 and the tween engine behind `transition`
//   intrinsics/   the elements that are more than a scene node: canvas (a wgpu
//                 surface) and image (an opt-in decode + upload path)
//   reconciler/   the universal-renderer config, and the names Solid's
//                 compiler emits calls against
//   runtime/      mounting, portals, app-level events, HMR, polyfills
//   testing/      the __cm_test surface an agent drives the app through
//
// The same shape as interface/renderer/react, so a fix in one has an obvious
// address in the other. `intrinsics/` is the one directory react has no need
// for: React reaches the same primitives through props on a host component.

export {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} from "./reconciler/renderer.ts";

export type { CmNode } from "./scene/node.ts";
export type { ClickEvent, PointerEvent } from "./scene/events.ts";

export { mount, createPortal } from "./runtime/mount.ts";
export { createPersistentSignal } from "./runtime/state.ts";
export {
  onThemeChange,
  onWindowFocus,
  onContextMenu,
  onKeyDown,
  onFileDrag,
} from "./runtime/app-events.ts";
export type {
  ContextMenuEvent,
  CarbonKeyEvent,
  FileDragEvent,
} from "./runtime/app-events.ts";

// Also export createEffect + createSignal from solid-js for convenience.
// Apps re-export from here so users have a single import.
export { createEffect, createSignal } from "solid-js";

// Side-effect modules: both install a global and export nothing.
import "./runtime/hmr.ts";
import "./testing/test-api.ts";

// Polyfills (performance, setTimeout, process, crypto stub) live in
// runtime/polyfills.ts and are deliberately NOT imported here. Apps that use
// NPM packages should `import "@carbon/mini-solid/polyfills"` as their FIRST
// import so the polyfills run before package module-init code touches them.
//
// The <image> intrinsic is opt-in the same way — `import
// { registerImageIntrinsic } from "@carbon/mini-solid/image"` — because
// registering it pulls in the decode path an app may never use.
