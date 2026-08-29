// @carbon/mini-react — React 18+ on top of carbon-mini's scene-graph host
// imports. Implements the react-reconciler HostConfig directly; never
// imports react-dom; never touches a DOM API. Each React fiber commits to
// a CmNode that calls into the runtime's __cm_* host imports.
//
//   import { render } from "@carbon/mini-react";
//   render(<App />);            // mounts under the runtime's root view
//
// Carbon-mini's scene-graph contract (host/imports.ts) is identical to what
// interface/renderer/solid binds to; the two adapters can coexist in the same
// JS context if needed.
//
// ── LAYOUT ──────────────────────────────────────────────────────────────────
//   host/         the seven host imports this renderer sits on
//   scene/        what a fiber commits to — the node, the root, its props,
//                 the event surface, and the DOM face libraries expect
//   styling/      runtime className resolution: Tailwind variants that could
//                 not be baked at build time
//   reconciler/   the HostConfig, and the flushSync trap that makes runtime
//                 events reach React's batching
//   runtime/      mounting: render, the react-dom/client shims, HMR, JSX
//   testing/      the __cm_test surface an agent drives the app through
//
// The same shape as interface/renderer/solid, so a fix in one has an obvious
// address in the other.
//
// Import order below is load-bearing.
//
// `runtime/refresh.ts` must run FIRST, before anything that pulls in the
// reconciler: it's what calls injectIntoGlobalHook(), installing the
// (real-or-stub) __REACT_DEVTOOLS_GLOBAL_HOOK__ that react-reconciler's
// own injectIntoDevTools() checks for. That check happens once, at
// host-config.ts's module-load time, and does nothing retroactively if
// the hook shows up later — verified directly against the installed
// react-reconciler source (injectInternals bails out immediately if
// `__REACT_DEVTOOLS_GLOBAL_HOOK__` is undefined at the moment it's
// called). Get the order backwards and Fast Refresh compiles, runs, and
// silently never patches anything.
//
// `runtime/render.ts` pulls in the reconciler next, which pulls in the
// scene, which pulls in the dispatcher traps — so the traps are installed
// before any dispatcher is assigned. See the note at the top of
// reconciler/flush-sync.ts.
import "./runtime/refresh.ts";

export { render } from "./runtime/render.ts";
export {
  createRoot,
  hydrateRoot,
  flushSync,
  createPortal,
  default,
  type RootApi,
} from "./runtime/react-dom.ts";

export type { CmNode } from "./scene/node.ts";
export type { ClickEvent } from "./scene/events.ts";
export { resolveNodeClassName } from "./styling/class-names.ts";

// Side-effect modules: both install a global and export nothing.
import "./runtime/hmr.ts";
import "./testing/test-api.ts";

// Re-export common React things so apps can do single-import.
export { default as React } from "react";
