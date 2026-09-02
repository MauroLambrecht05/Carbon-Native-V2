// The JavaScript side of the event loop: draining jobs, escaping strings, and
// reporting panics.
//
// `drain_js_jobs` runs QuickJS's pending-job queue — promise continuations and
// async callbacks — which nothing else pumps. `drain_and_flush_react` also
// calls the React reconciler's flush, since React batches through its own
// scheduler rather than the microtask queue.
//
// `js_string_literal` and `json_escape` build JavaScript source that Rust then
// evaluates. That is the direction of the boundary contracts/runtime calls
// dispatchers: a name inside a string, invisible to both compilers.

use super::*;

/// Drain QuickJS's pending-job queue (Promise resolutions, queueMicrotask
/// callbacks, etc.) AND force-flush React's pending Concurrent-mode work.
/// Must be called after every operation that touches the JS context;
/// without it async chains never advance — React's passive effects never
/// fire, fetch().then() callbacks never run, and the app freezes at its
/// initial render. Loops with a generous safety cap so a runaway promise
/// chain still returns control to the event loop.
pub(crate) fn drain_js_jobs(rt: &rquickjs::Runtime) {
    drain_js_jobs_counted(rt);
}

/// Returns the number of jobs executed (for drain instrumentation).
pub(crate) fn drain_js_jobs_counted(rt: &rquickjs::Runtime) -> usize {
    let mut iters = 0usize;
    while iters < 10_000 {
        match rt.execute_pending_job() {
            Ok(true) => {
                iters += 1;
            }
            Ok(false) => break,
            Err(e) => {
                eprintln!("[carbon-mini] pending job error: {e:?}");
                return iters;
            }
        }
    }
    if iters >= 10_000 {
        eprintln!("[carbon-mini] drain_js_jobs hit 10k iteration cap");
    }
    iters
}

/// Force-flush any React Concurrent-mode work queued up by setState()
/// calls inside Promise .then handlers / async/await continuations.
/// ConcurrentRoot batches those updates until the next "natural event
/// boundary"; carbon-mini doesn't have one, so we synthesize one here.
/// Pump pending microtasks both before and after so any setState that
/// fires inside the flush gets drained too.
pub(crate) fn drain_and_flush_react(rt: &rquickjs::Runtime, js_ctx: &rquickjs::Context) {
    let dbg = std::env::var_os("CARBON_DRAIN_DEBUG").is_some();
    let t = Instant::now();
    let j1 = drain_js_jobs_counted(rt);
    let d1 = t.elapsed().as_secs_f64() * 1000.0;
    let tf = Instant::now();
    let _ = js_ctx.with(|ctx| -> rquickjs::Result<()> {
        ctx.eval::<(), _>(
            b"globalThis.__cm_flush_react && globalThis.__cm_flush_react();".as_slice(),
        )?;
        Ok(())
    });
    let df = tf.elapsed().as_secs_f64() * 1000.0;
    let t2 = Instant::now();
    let j2 = drain_js_jobs_counted(rt);
    let d2 = t2.elapsed().as_secs_f64() * 1000.0;
    if dbg {
        eprintln!("[drain] jobs1={j1} ({d1:.1}ms)  flushReact={df:.1}ms  jobs2={j2} ({d2:.1}ms)");
    }
}

// Extracted to its own crate (no dependency on carbon-mini) — aliased so
// every existing `scene::X` / `crate::scene::X` call site here is unchanged.
// (blur.rs/svg.rs/canvas2d.rs moved into the paint crate — see the
// `use carbon_paint as paint;` / `use carbon_paint::canvas2d;` below.)
/// Encode a Rust string as a valid JS string literal — `"text"` with
/// quotes/control chars escaped. Used to inline values into the eval
/// snippet that fires onChange.
pub(crate) fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// Native QuickJS heap snapshot/restore (fixed-address arena). Gated behind the
// `snapshot` cargo feature; the module itself always compiles (Windows-only
// internals) but is only wired into startup + the spike under the feature.
// Extracted to its own crate — aliased so every `snapshot::` call site below
// is unchanged.
// canvas2d.rs (Native CanvasRenderingContext2D, CPU tiny-skia) moved into
// the paint crate — main.rs never called it directly, only paint's own
// dispatch code did.

/// The message + location of the most recent panic caught by the event
/// loop's `catch_unwind`. The panic hook (installed in `main`) fills this in
/// as the panic propagates; the catch site reads it to log / surface a useful
/// message instead of an opaque "thread panicked". Behind a Mutex so the hook
/// (which can run on any thread) and the main thread don't race.
pub(crate) static LAST_PANIC: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Install a process-wide panic hook that records the panic's message +
/// location into `LAST_PANIC` and echoes it to stderr. Paired with the
/// `catch_unwind` around the event-loop body: the hook captures the *why*
/// (the default hook's rich message) before the stack unwinds, and the catch
/// site keeps the app alive. Without the hook, `catch_unwind` only hands back
/// an opaque `Box<dyn Any>` that rarely carries the message.
pub(crate) fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = match info.payload().downcast_ref::<&str>() {
            Some(s) => (*s).to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => "unknown panic".to_string(),
            },
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let full = format!("panic at {loc}: {msg}");
        eprintln!("[carbon-mini] {full}");
        if let Ok(mut g) = LAST_PANIC.lock() {
            *g = Some(full);
        }
    }));
}

/// Best-effort human-readable description of the JS exception `ctx.catch()`
/// currently holds. Call only right after an `rquickjs::Error::Exception` —
/// that variant's own `Display` is just the fixed string "Exception
/// generated by QuickJS" (see result.rs), with the actual thrown value
/// (Error object, string, whatever `throw` was given) stashed on the
/// context instead of the Err, so a caller that only prints `{e}` reports
/// that something failed without ever saying what. Mirrors the exception
/// unpacking `bundle.rs`'s `eval_bundle_src` already does for the initial
/// bundle eval (kept separate rather than shared: that path carries its own
/// DEBUG instrumentation and sits on the app-launch critical path — not
/// worth touching to dedupe a dozen lines) so every other JS-thread eval
/// site (run_loop.rs's `eval_dispatch`) gets the same real diagnostic.
pub(crate) fn describe_js_exception(ctx: &rquickjs::Ctx<'_>) -> String {
    let exc = ctx.catch();
    if let Some(ex_obj) = exc.clone().into_object() {
        let msg: Option<String> = ex_obj.get("message").ok();
        let stack: Option<String> = ex_obj.get("stack").ok();
        let name: Option<String> = ex_obj.get("name").ok();
        match (name, msg, stack) {
            (Some(n), Some(m), Some(s)) => format!("{n}: {m}\n{s}"),
            (Some(n), Some(m), None) => format!("{n}: {m}"),
            (None, Some(m), Some(s)) => format!("{m}\n{s}"),
            (None, Some(m), None) => m,
            (_, None, Some(s)) => s,
            _ => format!("{:?}", ex_obj),
        }
    } else {
        let type_str = if exc.is_null() {
            "null"
        } else if exc.is_undefined() {
            "undefined"
        } else if exc.is_string() {
            "string"
        } else if exc.is_number() {
            "number"
        } else if exc.is_bool() {
            "bool"
        } else {
            "primitive"
        };
        // into_string() consumes the value; clone first.
        let str_form: String = match exc.clone().into_string() {
            Some(s) => s.to_string().unwrap_or_default(),
            None => format!("{:?}", exc),
        };
        format!("{type_str}: {str_form}")
    }
}

/// Minimal JSON-string escape for embedding a UTF-8 string into a JS source
/// snippet wrapped in double quotes. We use this to build the call site for
/// `__carbon_on_event(name, payloadJson)` from a plugin event.
///
/// We reach for hand-rolled escape rather than `serde_json::to_string` so
/// the surrounding quotes are added by the caller — keeps the call sites
/// readable at the string-literal level.
pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}
