// Universal dispatcher flushSync wrapper.
//
// The runtime calls `globalThis.__cm_dispatch_*(...)` from QuickJS-eval
// (outside React's event system). React's batched-updates machinery
// doesn't notice these calls, so a plain `setState(...)` inside a
// dispatcher handler is silently dropped — the render never commits, the
// useEffect never fires, the menu/tab/whatever never appears.
//
// We install accessor traps for every dispatcher name on globalThis so
// that *whichever package* assigns a handler — @carbon/compat-dom, the
// Solid mini-runtime, app code — the stored function is transparently
// wrapped in `reconciler.flushSync(...)` + a paint request. By the time
// any dispatcher actually fires the reconciler is initialised, so the
// wrapper just looks it up lazily.
//
// Wrapping is idempotent (we tag with __cmFlushWrapped so re-assignments
// don't pile up wrappers), and the setter trap catches future assignments
// — so order-of-import between this module, @carbon/compat-dom, and
// mini-runtime no longer matters.
//
// Names matched: anything starting with `__cm_dispatch_`, `__cm_*_dispatch_*`,
// or `__cm_window_dispatch_*` — i.e. the entire Rust→JS event surface.
//
// ── WHY THIS MODULE IMPORTS NOTHING ─────────────────────────────────────────
// The traps must be installed BEFORE scene/events.ts assigns its dispatchers,
// or those assignments never get wrapped. ES modules evaluate depth-first, so
// a module's imports run before its body — which means this file must sit at
// the bottom of the graph. It therefore does not import the reconciler it
// needs; host-config hands it over via `bindReconciler` once built, and
// scene/events.ts imports this file for the side effect to pin the order.

import "../host/imports.ts";

const FLUSH_DISPATCHER_KEYS = [
  "__cm_dispatch_click",
  "__cm_dispatch_input",
  "__cm_dispatch_keydown",
  "__cm_dispatch_context_menu",
  "__cm_dispatch_pointer",
  "__cm_dispatch_file_drag",
  "__cm_dispatch_theme_changed",
  "__cm_dispatch_window_focus",
  "__cm_window_dispatch_resize",
  "__cm_pty_dispatch_output",
  "__cm_pty_dispatch_exit",
  "__cm_fetch_dispatch_headers",
  "__cm_fetch_dispatch_chunk",
  "__cm_fetch_dispatch_end",
  "__cm_fetch_dispatch_error",
  "__cm_ws_dispatch_open",
  "__cm_ws_dispatch_message",
  "__cm_ws_dispatch_close",
  "__cm_ws_dispatch_error",
];

let boundReconciler: unknown = null;

/** Called by reconciler/host-config.ts the moment the reconciler exists. */
export function bindReconciler(r: unknown): void {
  boundReconciler = r;
}

/** Resolve the reconciler's synchronous-flush method across react-
 *  reconciler versions. 0.29 (React 18) exposed it as `flushSync`;
 *  0.31 (React 19) renamed to `flushSyncFromReconciler`. Both signatures
 *  are `(fn) => void`. */
export function resolveFlushSync(): ((cb: () => void) => void) | null {
  const r = boundReconciler as {
    flushSyncFromReconciler?: (cb: () => void) => void;
    flushSync?: (cb: () => void) => void;
  } | null;
  return r?.flushSyncFromReconciler ?? r?.flushSync ?? null;
}

function wrapDispatcherInFlushSync(fn: unknown): unknown {
  if (typeof fn !== "function") return fn;
  // Avoid re-wrapping when a dispatcher is chained (`prev?.()`) — that
  // would compound flushSync calls on every reassignment.
  if ((fn as { __cmFlushWrapped?: boolean }).__cmFlushWrapped) return fn;
  const wrapped: any = (...args: unknown[]) => {
    // The reconciler is bound later; by the time any dispatcher actually
    // fires, the module graph has finished initialising.
    const sync = resolveFlushSync();
    if (sync) {
      sync(() => {
        (fn as (...a: unknown[]) => void)(...args);
      });
      __cm_request_paint();
    } else {
      // Pre-reconciler-init path: just invoke. Anything called this
      // early can't depend on React state.
      (fn as (...a: unknown[]) => void)(...args);
    }
  };
  (wrapped as { __cmFlushWrapped: boolean }).__cmFlushWrapped = true;
  return wrapped;
}

{
  const g = globalThis as Record<string, unknown>;
  const storage: Record<string, unknown> = {};
  const installTrap = (key: string) => {
    storage[key] = wrapDispatcherInFlushSync(g[key]);
    try {
      Object.defineProperty(g, key, {
        configurable: true,
        enumerable: true,
        get() { return storage[key]; },
        set(v) { storage[key] = wrapDispatcherInFlushSync(v); },
      });
    } catch {
      // If a non-configurable property already exists (shouldn't, but
      // defensive), fall back to a direct overwrite.
      g[key] = storage[key];
    }
  };
  for (const k of FLUSH_DISPATCHER_KEYS) installTrap(k);
}
