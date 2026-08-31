// Shared by tray/global-shortcuts/deep-link: a `useEffect` whose body needs
// a plugin's native globals, which are not guaranteed to exist yet the
// first time the effect runs.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
// `carbon_plugin_register` (which installs a plugin's globals) runs AFTER
// the bundle evaluates — see products/carbon/composition/mini.rs and
// fonts.ts's own header comment for the fuller version of this. What that
// comment doesn't spell out, and what a real cold-launch test against tray
// caught directly (zero native calls, zero errors — pluginReady() silently
// false forever): this custom runtime's initial `useEffect` flush happens
// as part of that SAME bundle-evaluation pass, strictly before plugin
// registration — not after it, whatever a hook's own comment might have
// assumed. A one-shot `if (!pluginReady()) return;` inside a mount effect
// with a stable dependency array therefore loses this race on every cold
// `carbon run`/`carbon dev` launch, permanently, with no error to notice.
//
// ── WHY rAF POLLING, NOT A SECOND EFFECT ────────────────────────────────
// Same reasoning fonts.ts documents at length: a bare `setState` with no
// accompanying native-dispatched event is confirmed NOT to reliably flush a
// re-render in this runtime, so a second effect chained off state set from
// the first would hang forever on an app that receives no input before it
// needs its plugin ready. `requestAnimationFrame` is confirmed reliable
// with no interaction needed — run_loop.rs drains it every redraw frame —
// so this polls via rAF instead, fully independent of React's scheduler.

export function pluginGlobalReady(globalName: string): boolean {
  return typeof (globalThis as Record<string, unknown>)[globalName] === "function";
}

/**
 * Runs `effect` once `ready()` is true — immediately if it already is,
 * otherwise polling via `requestAnimationFrame` until it becomes true.
 * `effect`'s own cleanup (if it returns one) is called on unmount / deps
 * change; if unmount happens while still polling, the poll is cancelled
 * instead, before `effect` ever runs.
 *
 * Call from inside a `useEffect`, returning what this returns as that
 * effect's own cleanup:
 *
 *   useEffect(() => awaitPluginReady(pluginReady, () => {
 *     rawSetup(...);
 *     return () => rawTeardown(...);
 *   }), [deps]);
 */
export function awaitPluginReady(ready: () => boolean, effect: () => (() => void) | void): () => void {
  let cancelled = false;
  let cleanup: (() => void) | void;
  let rafId: number | null = null;

  const run = () => {
    if (cancelled) return;
    cleanup = effect();
  };

  if (ready()) {
    run();
  } else {
    const tick = () => {
      if (cancelled) return;
      if (!ready()) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      rafId = null;
      run();
    };
    rafId = requestAnimationFrame(tick);
  }

  return () => {
    cancelled = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (typeof cleanup === "function") cleanup();
  };
}
