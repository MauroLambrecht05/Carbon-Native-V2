// Mounting a React element tree into the scene root.

import { ConcurrentRoot } from "react-reconciler/constants";

import "../host/imports.ts";
import { getRoot } from "../scene/root.ts";
import { reconciler } from "../reconciler/host-config.ts";
import { resolveFlushSync } from "../reconciler/flush-sync.ts";

let containerHandle: any = null;

/**
 * Mount a React element tree into the carbon-mini scene root.
 * Subsequent calls re-render the same root (React's standard root API).
 *
 *   import { render } from "@carbon/mini-react";
 *   import App from "./App";
 *   render(<App />);
 */
export function render(element: any): void {
  // ─── Heap-snapshot deferred mount ───────────────────────────────────────
  // When carbon-mini builds a startup snapshot it evaluates the bundle purely
  // for module-init (defining React, the app's components, building the
  // `<App/>` element) and must NOT perform the actual mount — the mount calls
  // host imports (`__cm_create_node`, …) and reads back layout, none of which
  // exist at snapshot-build time, and doing it would also bake renderer state
  // the snapshot can't carry. So if the runtime set `__cm_defer_mount`, stash
  // the mount as a thunk (a plain JS closure that survives in the snapshot
  // heap) and return. After restoring the heap and registering the real host
  // imports, the runtime clears the flag and calls `__cm_run_deferred_mount()`,
  // which performs the mount fresh in the user's session.
  if ((globalThis as any).__cm_defer_mount) {
    (globalThis as any).__cm_run_deferred_mount = () => {
      (globalThis as any).__cm_defer_mount = false;
      render(element);
    };
    return;
  }
  const root = getRoot();
  if (!containerHandle) {
    // react-reconciler 0.29.x signature (React 18.3-compatible). The 0.30+
    // signature splits the error-handler argument into three separate ones
    // (onUncaughtError, onCaughtError, onRecoverableError); we pass the
    // react-reconciler 0.29 (React 18) arg shape. The React 19 / 0.31
    // shape (onUncaughtError + onCaughtError inserted) is a separate
    // upgrade task — that reconciler also renamed flushSync and changed
    // host-config interface in ways that go beyond a simple arg swap.
    containerHandle = (reconciler as any).createContainer(
      root,
      ConcurrentRoot,
      null,                       // hydrationCallbacks
      false,                      // isStrictMode
      null,                       // concurrentUpdatesByDefaultOverride
      "",                         // identifierPrefix
      (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[@carbon/mini-react] recoverable error:", err);
      },
      null,                       // transitionCallbacks
    );
  }
  // Wrap updateContainer in flushSync. With supportsMicrotasks:true, the
  // reconciler schedules its initial commit via queueMicrotask — but
  // carbon-mini's rquickjs host does NOT drain pending microtasks between
  // bundle eval and the first paint. Without flushSync the tree never
  // commits and the window stays empty. flushSync forces the work loop to
  // run synchronously so every __cm_create_node / __cm_set_prop call lands
  // before render() returns.
  const flush = resolveFlushSync();
  if (flush) {
    flush(() => {
      reconciler.updateContainer(element, containerHandle, null, () => {});
    });
  } else {
    // Reconciler doesn't expose a sync-flush API on this version —
    // attempt a plain commit. The first paint may show a partial tree
    // until rAF schedules a microtask drain.
    reconciler.updateContainer(element, containerHandle, null, () => {});
  }
  __cm_request_paint();

  // Expose a global force-flush so the host runtime can drain pending
  // React work after every JS-touching event. ConcurrentRoot defers
  // async setState() updates (Promise.then → setState, etc.) until a
  // "natural event boundary" that browsers have but carbon-mini lacks
  // — flushing here turns each microtask-drain tick into one of those
  // boundaries, so async state updates actually commit instead of
  // queueing forever.
  (globalThis as unknown as { __cm_flush_react?: () => void }).__cm_flush_react = () => {
    try {
      resolveFlushSync()?.(() => {});
    } catch { /* no-op if no work pending */ }
  };
}

/** Tear the mounted tree down and forget the container. Shared by
 *  `createRoot().unmount()` and the HMR reset. */
export function unmountRoot(): void {
  if (containerHandle) {
    try { reconciler.updateContainer(null, containerHandle, null, () => {}); } catch {}
    containerHandle = null;
  }
}
