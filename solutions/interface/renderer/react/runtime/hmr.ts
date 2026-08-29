// HMR reset hook — called by the host runtime before it re-evaluates the
// bundle on a `carbon dev` save.
//
// Used to unconditionally tear the whole tree down (unmountRoot + clear
// every scene map) so a full remount could rebuild it from scratch. Now a
// deliberate no-op: render.ts and host-config.ts cache the container and
// reconciler on globalThis specifically so the mounted tree survives a
// reload instead, and react-refresh (see runtime/refresh.ts) patches new
// component implementations into it in place. Clearing clickHandlers /
// inputHandlers / nodeTexts / nodeRegistry here would still be wrong even
// with that in mind: reconciliation only re-runs applyProps for nodes
// whose props actually changed, so any node that DIDN'T change on this
// particular edit would have its handlers cleared and never repopulated —
// its onClick would just silently stop firing after the next unrelated
// save. Left populated, they stay correct for exactly the same reason the
// tree itself is left mounted.
(globalThis as any).__cm_hmr_reset = () => {};

// The host runtime (run_loop.rs's ReloadBundle handler) ALSO unconditionally
// wiped the native scene graph on every reload — a step this file's own
// no-op above doesn't touch, because it's a separate, Rust-side action, not
// something __cm_hmr_reset controls. That wipe is exactly right for Solid's
// HMR model (a fresh mount() rebuilds everything from scratch right after),
// but it silently broke React: the reconciler's container survives the
// reload and diffs against its still-live fiber tree, so a Fast Refresh pass
// whose output didn't structurally change re-issues no __cm_insert_node
// calls at all — nothing was left to repopulate the scene the host had just
// cleared. Reproduced directly: "reloaded in N ms" with no error, followed by
// a fully blank window. This flag tells the host to skip that wipe.
(globalThis as any).__cm_hmr_keep_scene = true;

export {};
