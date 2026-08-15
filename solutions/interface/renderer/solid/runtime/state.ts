// Signals that survive a dev reload.

import { createEffect, createSignal } from "solid-js";

/**
 * Like Solid's `createSignal`, but the value is stashed in a global
 * `__hmr_state` Map keyed by `key` and restored across `--dev` HMR
 * reloads. Because the Rust runtime keeps the rquickjs context alive
 * across re-eval, this Map literally survives in the same JS heap —
 * so the new component's first read sees the previous value with no
 * disk hop, no serialization, no flash-of-stale state.
 *
 * Usage:
 *   const [count, setCount] = createPersistentSignal("counter.count", 0);
 *
 * Limitations (v1):
 *   - User must supply a stable key per signal. Future v2 lifts this
 *     via a Babel transform that auto-keys every createSignal call by
 *     (file, function name, signal-call index).
 *   - Stash values must be structurally cloneable — for v1 the only
 *     real constraint is "no functions, no scene-node refs". Numbers,
 *     strings, plain objects, and arrays all work.
 */
export function createPersistentSignal<T>(key: string, initial: T) {
  const stash: Map<string, unknown> =
    ((globalThis as any).__hmr_state ??= new Map());
  const restored = stash.has(key) ? (stash.get(key) as T) : initial;
  const [value, setValue] = createSignal<T>(restored);
  // Mirror every set into the stash. createEffect runs eagerly once,
  // so the initial value lands in the stash on first mount too — that
  // way the first reload-after-startup also restores cleanly even if
  // the user never called setValue.
  createEffect(() => {
    stash.set(key, value());
  });
  return [value, setValue] as const;
}

// Also export createEffect + createSignal from solid-js for convenience.
// Apps re-export from here so users have a single import.
export { createEffect, createSignal };
