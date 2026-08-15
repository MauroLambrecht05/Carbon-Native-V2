// react-dom/client compatibility.
//
// React apps coming from a normal browser/Tauri setup write:
//
//   import ReactDOM from "react-dom/client";
//   ReactDOM.createRoot(document.getElementById("root")).render(<App />);
//
// To let those apps run on carbon-mini without touching their entry, the
// build pipeline rewrites `react-dom/client` imports to point at this
// module. We expose `createRoot` (and `hydrateRoot`) with the same shape
// react-dom does — the returned root delegates to our scene-graph
// reconciler.
//
// The container argument is honored only for its semantic intent (the
// app picked a DOM node to mount into); the actual rendering target is
// always the carbon-mini scene root because the runtime owns the
// window's surface.

import "../host/imports.ts";
import { getRoot } from "../scene/root.ts";
import { reconciler } from "../reconciler/host-config.ts";
import { render, unmountRoot } from "./render.ts";

export interface RootApi {
  render(element: any): void;
  unmount(): void;
}

export function createRoot(_container: unknown, _options?: unknown): RootApi {
  // _container is whatever document.getElementById returned. We don't
  // need it — render() always targets the scene root.
  return {
    render(element: any) { render(element); },
    unmount() { unmountRoot(); },
  };
}

// Hydration in carbon-mini is the same as fresh render — there's no
// server-rendered HTML to attach to. Apps using SSR transitions should
// migrate to plain createRoot.
export function hydrateRoot(container: unknown, initialChildren: any, _options?: unknown): RootApi {
  const r = createRoot(container);
  r.render(initialChildren);
  return r;
}

// flushSync — react-dom's escape hatch for forcing a synchronous
// commit. Radix, floating-ui, and other libraries call it after
// imperative DOM mutations to make React reconcile immediately. We
// delegate to the reconciler's flushSync since our commit pipeline
// is the same.
export function flushSync<T>(fn: () => T): T {
  let result: T = undefined as any;
  (reconciler as any).flushSync(() => {
    result = fn();
  });
  __cm_request_paint();
  return result;
}

// createPortal — render children into a different parent. Carbon-mini
// is single-window, so there's nowhere to portal to that's outside the
// scene tree. We render children at the scene root so popovers /
// tooltips visually escape their containing flex box. The `container`
// arg is honored by id when it's a CmNode; otherwise the scene root
// is used as the target.
export function createPortal(children: any, container?: any, key?: any): any {
  // React-DOM uses a special $$typeof Symbol.for("react.portal"); we
  // mirror that so React-internal isPortal checks pass.
  const REACT_PORTAL_TYPE = Symbol.for("react.portal");
  // Pick the portal mount target. Radix's DropdownMenu / Tooltip /
  // Dialog all portal to document.body by default; @carbon/compat-dom's
  // body is a CarbonElement with `cmId` (not `id`). Accept anything
  // that looks like a carbon node — `cmId`, `id`, or our internal
  // numeric id — falling back to the scene root when the caller
  // passes something we can't recognise (or undefined for the
  // current-document body case).
  const looksLikeCmNode = (n: any): boolean =>
    !!n && typeof n === "object" && (
      typeof (n as { cmId?: unknown }).cmId === "number" ||
      typeof (n as { id?: unknown }).id === "number"
    );
  const targetNode = looksLikeCmNode(container) ? container : getRoot();
  return {
    $$typeof: REACT_PORTAL_TYPE,
    key: key == null ? null : String(key),
    children,
    containerInfo: targetNode,
    implementation: null,
  };
}

// react-dom default export — apps that do `import ReactDOM from
// "react-dom/client"` get an object with createRoot/hydrateRoot on it.
const reactDomClient = { createRoot, hydrateRoot, flushSync, createPortal };
export default reactDomClient;
