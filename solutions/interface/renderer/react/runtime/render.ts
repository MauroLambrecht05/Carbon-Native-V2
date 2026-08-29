// Mounting a React element tree into the scene root.

import { ConcurrentRoot } from "react-reconciler/constants";

import "../host/imports.ts";
import { getRoot } from "../scene/root.ts";
import { reconciler } from "../reconciler/host-config.ts";
import { resolveFlushSync } from "../reconciler/flush-sync.ts";
import { performReactRefresh } from "./refresh.ts";

// The container lives on globalThis, not a module-level `let`, because
// this file — like the rest of @carbon/mini-react — is bundled into the
// APP half of a split build (see BunBundler.ts's SPLIT_KEEP_IN_APP) and
// re-evaluates on every `carbon dev` reload. A module-level `let` would
// reset to null on every reload, same as it always has, throwing away the
// mounted tree and remounting from scratch — which is the behavior this
// exists to stop. globalThis is the one thing the Rust runtime keeps
// alive across a reload (same reasoning as hmr.ts's stash), so caching
// the container there is what makes it actually survive.
const g = globalThis as unknown as { __cm_react_container?: unknown };

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

  const isReload = !!g.__cm_react_container;
  if (!isReload) {
    // First-ever mount this session: allocate the root scene node and a
    // fresh reconciler container. getRoot() lives here, inside the
    // "first mount only" branch, deliberately — it lazily creates scene
    // node id 1 via __cm_create_node the first time it's called (see
    // scene/root.ts), and calling it again on a reload (its own module
    // state reset the same way this file's would have been) would
    // recreate that node a second time under the same id. Skipping the
    // call entirely on a reload is what keeps it a no-op there.
    const root = getRoot();
    // react-reconciler 0.29.x signature (React 18.3-compatible). The 0.30+
    // signature splits the error-handler argument into three separate ones
    // (onUncaughtError, onCaughtError, onRecoverableError); we pass the
    // react-reconciler 0.29 (React 18) arg shape. The React 19 / 0.31
    // shape (onUncaughtError + onCaughtError inserted) is a separate
    // upgrade task — that reconciler also renamed flushSync and changed
    // host-config interface in ways that go beyond a simple arg swap.
    g.__cm_react_container = (reconciler as any).createContainer(
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

  // updateContainer(element, ...) runs on EVERY render — mount and reload
  // alike. performReactRefresh() is called first on a reload (patching new
  // $RefreshReg$-registered implementations into react-refresh's family
  // registry so resolveFamily, wired into the reconciler via
  // injectIntoDevTools/setRefreshHandler in host-config.ts, can recognize
  // "same family, new function reference" during the update() diff below
  // instead of remounting) — but NOT as a render pass of its own anymore.
  //
  // It used to be: call performReactRefresh() and let ITS OWN scheduleRefresh
  // walk (the same update-scheduling path updateContainer uses) be the
  // entire re-render, skipping updateContainer on reload so as not to
  // double-render. Debug-instrumented every host-config call by node id to
  // find out why buttons stopped responding after a few reloads, and the
  // full sequence for a reload was: createInstance for all thirteen nodes
  // (fresh ids, 118-130) → appendInitialChild building the fresh subtree →
  // ONE appendChildToContainer(newRoot, container) — with NO clearContainer
  // and NO removeChild for the OLD subtree (105-117) anywhere in the trace.
  // performReactRefresh()'s own remount path does not go through this
  // reconciler's normal unmount lifecycle the way a `key` change or an
  // updateContainer-driven type mismatch does; it just appends the new
  // subtree as an extra child of the SAME root, leaving the old one attached
  // and its old clickHandlers entries never cleaned up. Two full trees,
  // stacked, no error — the visibly wrong tree just happened to have the
  // working handlers, and the correct-looking one on top didn't.
  //
  // updateContainer(element, ...) with a genuinely fresh `element` (built
  // by the newly re-evaluated main.tsx) goes through NORMAL reconciliation
  // instead: resolveFamily lets it recognize the root's child as the same
  // family despite the new App function reference, so it takes the ordinary
  // commitUpdate path — preserving hook state exactly like a real browser's
  // Fast Refresh, through the diff react-reconciler already knows how to do
  // correctly, rather than react-refresh's own remount fallback.
  const doRender = () => {
    if (isReload) {
      performReactRefresh();
    }
    reconciler.updateContainer(element, g.__cm_react_container, null, () => {});
  };

  // Wrap in flushSync. With supportsMicrotasks:true, the reconciler
  // schedules its initial commit via queueMicrotask — but carbon-mini's
  // rquickjs host does NOT drain pending microtasks between bundle eval and
  // the first paint. Without flushSync the tree never commits and the
  // window stays empty. flushSync forces the work loop to run synchronously
  // so every __cm_create_node / __cm_set_prop call lands before render()
  // returns.
  const flush = resolveFlushSync();
  if (flush) {
    flush(doRender);
  } else {
    // Reconciler doesn't expose a sync-flush API on this version —
    // attempt a plain commit. The first paint may show a partial tree
    // until rAF schedules a microtask drain.
    doRender();
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
  if (g.__cm_react_container) {
    try { reconciler.updateContainer(null, g.__cm_react_container, null, () => {}); } catch {}
    g.__cm_react_container = undefined;
  }
}
