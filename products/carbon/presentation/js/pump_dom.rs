// Driving the JS engine from the event loop.
//
// `drain_jobs` runs QuickJS's pending-job queue; `drain_and_flush` also calls
// the React reconciler, which batches through its own scheduler rather than the
// microtask queue. `tick_js_frame` is one frame's worth of both.

use super::*;

/// Escape a string for embedding inside a JS double-quoted string literal
/// (returns the inner content, no surrounding quotes). Used for PluginEvent.
pub(crate) fn json_escape(s: &str) -> String {
    let full = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    full.get(1..full.len().saturating_sub(1))
        .unwrap_or("")
        .to_string()
}

// ─── Bridge state ───────────────────────────────────────────────────────────
//
// The QuickJS runtime is single-threaded and lives on the main (event-loop)
// thread, so a thread-local holds the document the `__cm_*` host imports mutate.
// This mirrors the way carbon-mini keeps its Scene reachable from the host
// closures — but here the closures capture nothing (they reach the thread-local
// directly), which sidesteps the Arc<Mutex> capture + Send bounds entirely.

/// Drain QuickJS's pending-job queue (Promise resolutions, queueMicrotask,
/// our microtask-backed setTimeout). Without this, async chains never advance
/// and React never commits its initial render. Mirrors carbon-mini.
pub(crate) fn drain_jobs(rt: &JsRuntime) {
    let mut i = 0;
    loop {
        match rt.execute_pending_job() {
            Ok(true) => {
                i += 1;
                if i > 200_000 {
                    eprintln!("[mini-blitz] drain hit iteration cap");
                    break;
                }
            }
            Ok(false) => break,
            Err(e) => {
                eprintln!("[mini-blitz] pending job error: {e:?}");
                break;
            }
        }
    }
}

/// Drain jobs, force-flush React's concurrent work, drain again. carbon apps
/// have no natural event boundary, so we synthesize one (same as mini).
pub(crate) fn drain_and_flush(rt: &JsRuntime, ctx: &JsContext) {
    drain_jobs(rt);
    let _ = ctx.with(|ctx| {
        ctx.eval::<(), _>(
            b"globalThis.__cm_flush_react && globalThis.__cm_flush_react();".as_slice(),
        )
    });
    drain_jobs(rt);
}

/// One frame of JS work: fire due timers + queued rAF callbacks, then advance
/// microtasks and flush React. Returns true if animation-frame work is still
/// pending (so the loop keeps ticking at ~60fps instead of sleeping).
pub(crate) fn tick_js_frame(rt: &JsRuntime, ctx: &JsContext) -> bool {
    let _ = ctx.with(|c| {
        c.eval::<(), _>(
            b"globalThis.__cm_run_timers&&__cm_run_timers();globalThis.__cm_run_raf&&__cm_run_raf();"
                .as_slice(),
        )
    });
    drain_and_flush(rt, ctx);
    ctx.with(|c| {
        c.eval::<bool, _>(b"!!(globalThis.__cm_has_pending&&__cm_has_pending())".as_slice())
            .unwrap_or(false)
    })
}

// ─── __cm_* host-import implementations (drive the blitz DocumentMutator) ─────
