// Mounting a component tree, and portalling part of one somewhere else.

import { batch, createRoot, onCleanup } from "solid-js";

import "../host/imports.ts";
import type { CmNode } from "../scene/node.ts";
import { getRoot } from "../scene/root.ts";
import { insert, render } from "../reconciler/renderer.ts";

// Tracks Solid's dispose handle for the most recent mount. Used by HMR
// teardown so reloads dispose the previous owner tree (and its effects)
// before constructing a new one.
let lastDispose: (() => void) | null = null;

/** Mount a component as the root of the scene graph. */
export function mount(component: () => any): void {
  // Track the dispose handle returned by Solid's render() so HMR reloads
  // can tear down the previous reactive owner tree before mounting the
  // new one. Without this, signals from the old component graph keep
  // their effects alive — when the new bundle re-creates them under
  // (presumably) different node IDs, the stale effects fire against
  // dead scene nodes and we get phantom paints / leaks.
  if (lastDispose) {
    try { lastDispose(); } catch {}
    lastDispose = null;
  }
  lastDispose = render(component, getRoot());
  __cm_request_paint();

  // The host runtime forces a render commit after every JS-touching event
  // (click dispatch, plugin event, HMR reload — see products/carbon's
  // drain_and_flush_react) by calling `globalThis.__cm_flush_react`. The
  // React renderer installs one; the Solid renderer never did, so every
  // effect Solid schedules rather than runs synchronously (createEffect,
  // onMount, and any insert() committed while queued behind one) was queued
  // forever and never committed to the scene graph — signals updated
  // correctly, JSX never visibly reflected it, with no error anywhere.
  // `batch(() => {})` is solid-js's own public flush primitive: entering
  // and leaving a batch (even an empty one) drains whatever the shared
  // scheduler is currently holding, the same way a non-empty batch would
  // flush the updates made inside it.
  (globalThis as unknown as { __cm_flush_react?: () => void }).__cm_flush_react = () => {
    try {
      batch(() => {});
    } catch {
      /* no-op if nothing pending */
    }
  };
}

/** HMR: dispose the mounted owner tree. Returns once the handle is cleared. */
export function disposeMounted(): void {
  if (lastDispose) {
    try { lastDispose(); } catch {}
    lastDispose = null;
  }
}

// ─── createPortal ────────────────────────────────────────────────────────
//
// Renders a child into a different parent in the scene graph. The
// canonical use is overlays — modals, tooltips, dropdowns, toasts —
// that visually escape their containing element's overflow / clip
// box. Without portals, anything painted by a deeply-nested component
// is bounded by its ancestors' overflow:hidden + z-index stacking,
// which is the wrong layout for floating UI.
//
// Implementation: spawn a Solid sub-tree under `createRoot` rooted at
// `target` (defaults to the scene root). Cleanup is tied to the
// calling component's owner via `onCleanup`, so portals dispose when
// the host component unmounts — no manual teardown required.
//
// Usage:
//   <view>
//     <button onClick={() => setOpen(true)}>Open</button>
//     {open() && createPortal(() => (
//       <view style={{ position: "absolute", top: "20%", left: "30%" }}>
//         Modal content
//       </view>
//     ))}
//   </view>
export function createPortal(
  component: () => any,
  target?: CmNode
): null {
  const portalParent = target ?? getRoot();
  let dispose: (() => void) | null = null;
  createRoot((d) => {
    dispose = d;
    (insert as any)(portalParent, component);
  });
  onCleanup(() => {
    if (dispose) {
      try { dispose(); } catch (_) {}
      dispose = null;
    }
  });
  // Nothing rendered at the call site — the portal owns its own sub-tree.
  return null;
}

// `@CarbonApp` is a custom carbon-mini directive (NOT a TypeScript
// decorator). Both the build pipeline and the @carbon/ts-plugin
// strip the line and inject a mount call before either tool parses
// the file — so there's nothing to expose at runtime. The user just
// writes:
//
//   @CarbonApp
//   function App() { return <view>...</view>; }
//
// …and it Just Works in their editor and at build time.

