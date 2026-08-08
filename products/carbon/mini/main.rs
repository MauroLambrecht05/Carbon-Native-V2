// carbon-mini v2 — webview-less desktop runtime POC.
//
// Pipeline:
//   tao window -> softbuffer surface -> tiny-skia paint into a pixmap ->
//   fontdue glyph rasterization for text -> blit into softbuffer.
//
// Solid (or any framework) drives the scene graph through host imports
// implemented in rquickjs. Layout is Taffy. No Skia/ICU.

use anyhow::{anyhow, Context, Result};
use rquickjs::context::intrinsic;
use rquickjs::{Context as JsContext, Function, Runtime as JsRuntime};
use std::cell::RefCell;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

// Last known window dimensions, kept in JS-thread-reachable storage so
// the __cm_layout_box host import can compute a fresh layout against
// the current viewport without waiting for the next paint. Updated on
// every WindowEvent::Resized.
static HOST_WINDOW_SIZE: Mutex<(f32, f32)> = Mutex::new((1280.0, 800.0));
use std::time::Instant;
use tao::dpi::LogicalSize;
use tao::event::{ElementState, Event, MouseButton, WindowEvent};
use tiny_skia::{Paint, Rect, Transform};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::keyboard::{Key, ModifiersState};
use tao::window::WindowBuilder;

/// Profiling — optional frame zone markers.
/// When profiling feature is enabled, emits marker names for external profilers (Tracy, etc).
/// When disabled, compiles to nothing (zero overhead).
#[cfg(feature = "profiling")]
macro_rules! prof_zone {
    ($name:expr) => {
        if std::env::var_os("CARBON_MINI_PROFILING").is_some() {
            eprintln!("[prof-zone-start] {}", $name);
        }
    };
}
#[cfg(not(feature = "profiling"))]
macro_rules! prof_zone {
    ($name:expr) => {};
}

/// Per-phase startup timing. Prints one line per phase showing how long THAT
/// phase took (`+Δms`) plus the cumulative time since start (`= total`). On by
/// default so `carbon run` shows the breakdown in the console; silence with
/// CARBON_NO_TIMING=1. The `phase=…`/`elapsed_ms=…` tokens are kept for the
/// bench harness that greps them.
fn timing_log(phase: &str, since: Instant) {
    if std::env::var_os("CARBON_NO_TIMING").is_some() {
        return;
    }
    use std::io::Write;
    // Track the previous phase's instant so we can report per-phase deltas.
    static LAST: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    let now = Instant::now();
    let elapsed = now.duration_since(since).as_secs_f64() * 1000.0;
    let delta = {
        let mut g = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let d = match *g {
            Some(prev) => now.duration_since(prev).as_secs_f64() * 1000.0,
            None => elapsed,
        };
        *g = Some(now);
        d
    };
    // Clean + aligned, while keeping the `phase=…`/`elapsed_ms=…` tokens the
    // bench harness greps for.
    eprintln!("[timing] phase={phase:<28} +{delta:>8.2}ms   total {elapsed:>8.2}ms   elapsed_ms={elapsed:.2}");
    let _ = std::io::stderr().flush();
}

/// Process start instant, so any module (not just `main`) can emit a granular
/// timing phase via [`tlog`] without threading the start `Instant` everywhere.
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Emit a timing phase relative to process start. Used by sub-modules
/// (e.g. `native::register_all`) for fine-grained sub-step timing.
pub fn tlog(phase: &str) {
    if let Some(t0) = START.get() {
        timing_log(phase, *t0);
    }
}

/// Final "everything done" line: the grand total since start.
fn timing_done(label: &str, since: Instant) {
    if std::env::var_os("CARBON_NO_TIMING").is_some() {
        return;
    }
    use std::io::Write;
    let ms = since.elapsed().as_secs_f64() * 1000.0;
    eprintln!("[timing] ───────────────────────────────────────────────");
    eprintln!("[timing] ✓ {label}: TOTAL {ms:.2} ms");
    let _ = std::io::stderr().flush();
}

/// Drain QuickJS's pending-job queue (Promise resolutions, queueMicrotask
/// callbacks, etc.) AND force-flush React's pending Concurrent-mode work.
/// Must be called after every operation that touches the JS context;
/// without it async chains never advance — React's passive effects never
/// fire, fetch().then() callbacks never run, and the app freezes at its
/// initial render. Loops with a generous safety cap so a runaway promise
/// chain still returns control to the event loop.
fn drain_js_jobs(rt: &rquickjs::Runtime) {
    drain_js_jobs_counted(rt);
}

/// Returns the number of jobs executed (for drain instrumentation).
fn drain_js_jobs_counted(rt: &rquickjs::Runtime) -> usize {
    let mut iters = 0usize;
    while iters < 10_000 {
        match rt.execute_pending_job() {
            Ok(true) => { iters += 1; }
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
fn drain_and_flush_react(rt: &rquickjs::Runtime, js_ctx: &rquickjs::Context) {
    let dbg = std::env::var_os("CARBON_DRAIN_DEBUG").is_some();
    let t = Instant::now();
    let j1 = drain_js_jobs_counted(rt);
    let d1 = t.elapsed().as_secs_f64() * 1000.0;
    let tf = Instant::now();
    let _ = js_ctx.with(|ctx| -> rquickjs::Result<()> {
        ctx.eval::<(), _>(b"globalThis.__cm_flush_react && globalThis.__cm_flush_react();".as_slice())?;
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
use carbon_layout::scene;
mod async_image;
// V1 spliced carbon/runtime/mod.rs in here textually (`include!`), so that
// unqualified `native::`, `platform::`, `os_theme::`, `host_exports::` and
// `plugin_loader::` call sites resolved without a module path. Those are five
// crates now. Re-binding the old names keeps every call site in this file
// exactly as it was, which is the point: a 4,400-line composition root is not
// where you want to also be rewriting a few hundred paths.
use carbon_runtime_contract::{UserEvent, WindowOp};
use carbon_os as native;
use carbon_os::os_theme;
use carbon_platform as platform;
use carbon_plugin_host::host_exports;
use carbon_plugin_host::plugin_loader;
use scene::{PaintProps, Scene};

// Extracted to its own crate (no dependency on carbon-mini) — aliased so
// every existing `text::TextEngine` call site is unchanged.
use carbon_text_renderer as text;

/// Walk from root to find a node and return its accumulated x offset
/// (useful for hit-test math where we have a screen coordinate and need
/// it in box-local space). Scene doesn't track parent ids, so we walk
/// down. Returns 0.0 if the node has no computed layout yet.
fn absolute_x(s: &Scene, target: u32) -> f32 {
    fn walk(s: &Scene, id: u32, target: u32, acc: f32) -> Option<f32> {
        let n = s.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let x = acc + layout.location.x;
        if id == target {
            return Some(x);
        }
        for &c in &n.children {
            if let Some(found) = walk(s, c, target, x) {
                return Some(found);
            }
        }
        None
    }
    walk(s, s.root, target, 0.0).unwrap_or(0.0)
}

/// Companion to [`absolute_x`] for the y axis.
fn absolute_y(s: &Scene, target: u32) -> f32 {
    fn walk(s: &Scene, id: u32, target: u32, acc: f32) -> Option<f32> {
        let n = s.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let y = acc + layout.location.y;
        if id == target {
            return Some(y);
        }
        for &c in &n.children {
            if let Some(found) = walk(s, c, target, y) {
                return Some(found);
            }
        }
        None
    }
    walk(s, s.root, target, 0.0).unwrap_or(0.0)
}

// debug_color_for_id / hsv_to_rgb moved into the paint crate (its only
// caller); main.rs no longer needs them.

/// Encode a Rust string as a valid JS string literal — `"text"` with
/// quotes/control chars escaped. Used to inline values into the eval
/// snippet that fires onChange.
fn js_string_literal(s: &str) -> String {
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

// gpu/executor/material/geometry/uniforms extracted to carbon-gpu-canvas —
// aliased so every existing `gpu::X` call site is unchanged. Only `gpu` is
// referenced outside that crate; executor/material/geometry/uniforms were
// always internal to how gpu.rs implements the canvas.
#[cfg(feature = "gpu")]
use carbon_gpu_canvas::gpu;

// Native QuickJS heap snapshot/restore (fixed-address arena). Gated behind the
// `snapshot` cargo feature; the module itself always compiles (Windows-only
// internals) but is only wired into startup + the spike under the feature.
// Extracted to its own crate — aliased so every `snapshot::` call site below
// is unchanged.
use carbon_snapshot as snapshot;
// canvas2d.rs (Native CanvasRenderingContext2D, CPU tiny-skia) moved into
// the paint crate — main.rs never called it directly, only paint's own
// dispatch code did.

// carbon-image: opt-in image loading (DISABLED in Phase 1A to save 0.8 MB).
// When enabled, activated when the env var CARBON_IMAGE_PATHS is set
// (comma-separated glob allowlist) or CARBON_IMAGE=1 (dev mode).
#[cfg(feature = "image")]
fn maybe_register_image(
    js_ctx: &rquickjs::Context,
    project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    // Read the glob allowlist from env. If unset, image loading is disabled.
    let raw = std::env::var("CARBON_IMAGE_PATHS").unwrap_or_default();
    let enable_all = std::env::var("CARBON_IMAGE").ok().as_deref() == Some("1");

    if raw.is_empty() && !enable_all {
        return Ok(()); // image loading off
    }

    let mut globs: Vec<String> = if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(',').map(|s| s.trim().to_string()).collect()
    };

    if enable_all && globs.is_empty() {
        // Dev mode: allow everything.
        globs.push("**".to_string());
    }

    // Expand ${APP} → project_dir.
    let app_path = project_dir.to_string_lossy().replace('\\', "/");
    let globs: Vec<String> = globs
        .into_iter()
        .map(|g| g.replace("${APP}", &app_path))
        .collect();

    let cache = carbon_image::default_cache();
    js_ctx.with(|ctx| -> anyhow::Result<()> {
        carbon_image::register_image(&ctx, cache, globs)
            .map_err(|e| anyhow::anyhow!("register_image: {e}"))?;
        Ok(())
    })?;

    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!("[carbon-mini] image loading registered");
    }
    Ok(())
}

#[cfg(not(feature = "image"))]
fn maybe_register_image(
    _js_ctx: &rquickjs::Context,
    _project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    // Image feature disabled; no-op.
    Ok(())
}

/// Register Web Audio API globals (DISABLED in Phase 1A to save 0.4 MB).
/// When enabled, only if env var or carbon.toml enables it.
#[cfg(feature = "audio")]
fn maybe_register_audio(
    js_ctx: &rquickjs::Context,
    project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    let audio_from_env = std::env::var_os("CARBON_MINI_AUDIO").is_some();
    let audio_from_toml = std::fs::read_to_string(project_dir.join("carbon.toml"))
        .map(|s| s.contains("audio = true"))
        .unwrap_or(false);

    if !audio_from_env && !audio_from_toml {
        return Ok(());
    }

    js_ctx.with(|ctx| -> anyhow::Result<()> {
        carbon_audio::register_audio(&ctx)
            .map_err(|e| anyhow::anyhow!("register_audio: {e}"))?;
        Ok(())
    })?;

    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!("[carbon-mini] Web Audio API registered");
    }
    Ok(())
}

#[cfg(not(feature = "audio"))]
fn maybe_register_audio(
    _js_ctx: &rquickjs::Context,
    _project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    // Audio feature disabled; no-op.
    Ok(())
}



/// Build-time helper: compile a JS bundle to QuickJS bytecode, then
/// zstd-compress it. The runtime reads the .qbc.zst file directly,
/// decompresses to memory, deserializes via JS_ReadObject — no parse step.
///
/// Usage: carbon-mini.exe --compile-bundle <input.js> <output.qbc.zst>
fn compile_bundle(input: &str, output: &str) -> Result<()> {
    let src = std::fs::read(input).with_context(|| format!("read {input}"))?;
    let rt = JsRuntime::new().map_err(|e| anyhow!("rt: {e}"))?;
    let ctx = JsContext::builder()
        .with::<intrinsic::Eval>()
        .with::<intrinsic::RegExp>()
        .with::<intrinsic::Json>()
        .with::<intrinsic::MapSet>()
        .with::<intrinsic::TypedArrays>()
        .build(&rt)
        .map_err(|e| anyhow!("ctx: {e}"))?;
    ctx.with(|ctx| -> Result<()> {
        // Compile (don't execute) — JS_Eval with EVAL_TYPE_GLOBAL | EVAL_FLAG_COMPILE_ONLY
        // returns a function value containing the bytecode. We then serialize
        // it via JS_WriteObject. This is the same shape the runtime uses on load.
        use rquickjs::qjs;
        let mut src_with_null = src.clone();
        src_with_null.push(0);
        let cstr_ptr = src_with_null.as_ptr() as *const i8;
        let filename = std::ffi::CString::new(input).unwrap();
        let raw_ctx = ctx.as_raw().as_ptr();
        let func_val = unsafe {
            qjs::JS_Eval(
                raw_ctx,
                cstr_ptr,
                src.len() as u64,
                filename.as_ptr(),
                (qjs::JS_EVAL_TYPE_GLOBAL | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
            )
        };
        if unsafe { qjs::JS_IsException(func_val) } {
            return Err(anyhow!("compile failed (JS exception)"));
        }
        let mut out_len: u64 = 0;
        let buf_ptr = unsafe {
            qjs::JS_WriteObject(
                raw_ctx,
                &mut out_len as *mut u64,
                func_val,
                qjs::JS_WRITE_OBJ_BYTECODE as i32,
            )
        };
        if buf_ptr.is_null() {
            return Err(anyhow!("JS_WriteObject returned null"));
        }
        let bytes = unsafe { std::slice::from_raw_parts(buf_ptr, out_len as usize).to_vec() };
        unsafe {
            qjs::js_free(raw_ctx, buf_ptr as *mut std::ffi::c_void);
            qjs::JS_FreeValue(raw_ctx, func_val);
        }
        // lz4-compress the bytecode. Pure-Rust, ~4 GB/s decompress, modest
        // compression ratio (~2× worse than zstd) but adds ~50 KB to the binary
        // vs zstd's ~420 KB. Worth the trade for 36-100 KB bundles.
        // Frame format: 4-byte little-endian uncompressed length prefix +
        // raw lz4 block. Lets the decoder pre-allocate the exact output size.
        let mut compressed = (bytes.len() as u32).to_le_bytes().to_vec();
        compressed.extend_from_slice(&lz4_flex::compress(&bytes));
        std::fs::write(output, &compressed).with_context(|| format!("write {output}"))?;
        eprintln!(
            "[carbon-mini] compiled {} ({} B JS) -> {} ({} B .qbc.zst, {} B bytecode pre-compress)",
            input, src.len(), output, compressed.len(), bytes.len()
        );
        Ok(())
    })?;
    Ok(())
}

/// Read the bundle at `path` and eval it in the given JS context.
/// Used for both initial startup and HMR reloads.
///
/// Three formats supported (same as before):
///   .qbc.zst — lz4-compressed bytecode (default when [runtime] bytecode = true)
///   .qbc     — raw bytecode (rare; if user pre-decompressed)
///   .js      — source, parse-and-eval at runtime
///
/// The .js source path wraps the bundle in an IIFE before eval. This is
/// strictly required for HMR: re-eval'ing top-level `const` / `let`
/// declarations in the same context throws "redeclaration of const X"
/// inside QuickJS. Wrapping in `(function(){ ... })()` makes every
/// declaration local to a fresh function scope, so reloads compose cleanly.
/// Bytecode-compiled scripts already have their own scope per JS_ReadObject
/// payload, so they don't need the wrapper.
///
/// Split into two phases so the disk read + lz4 decompress can run on a
/// worker thread while the main thread builds the OS window. `read_bundle`
/// is Send and side-effect-free; `eval_bundle_src` requires the main JS
/// context and must run on the thread that owns it.
struct BundleSrc {
    bytes: Vec<u8>,
    is_bytecode: bool,
}

fn read_bundle(path: &PathBuf) -> Result<BundleSrc> {
    let raw = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let path_str = path.to_string_lossy();
    let is_zst = path_str.ends_with(".qbc.zst");
    let is_bytecode = is_zst || path_str.ends_with(".qbc");
    let bytes: Vec<u8> = if is_zst {
        if raw.len() < 4 {
            return Err(anyhow!("bundle .qbc.zst too short ({} B)", raw.len()));
        }
        let uncompressed_len = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        lz4_flex::decompress(&raw[4..], uncompressed_len)
            .map_err(|e| anyhow!("lz4 decompress {}: {e}", path.display()))?
    } else {
        raw
    };
    Ok(BundleSrc { bytes, is_bytecode })
}

fn eval_bundle_src(js_ctx: &JsContext, src: &BundleSrc) -> Result<()> {
    let is_bytecode = src.is_bytecode;
    let src = &src.bytes;
    js_ctx.with(|ctx| -> Result<()> {
        if is_bytecode {
            use rquickjs::qjs;
            let raw_ctx = ctx.as_raw().as_ptr();
            let func_val = unsafe {
                qjs::JS_ReadObject(
                    raw_ctx,
                    src.as_ptr(),
                    src.len() as u64,
                    qjs::JS_READ_OBJ_BYTECODE as i32,
                )
            };
            if unsafe { qjs::JS_IsException(func_val) } {
                return Err(anyhow!("JS_ReadObject failed (bad bytecode)"));
            }
            let result = unsafe { qjs::JS_EvalFunction(raw_ctx, func_val) };
            if unsafe { qjs::JS_IsException(result) } {
                // Read the actual exception so we get a useful error.
                let exc = unsafe { qjs::JS_GetException(raw_ctx) };
                let msg = unsafe {
                    let cstr = qjs::JS_ToCString(raw_ctx, exc);
                    let s = if cstr.is_null() {
                        "<unprintable exception>".to_string()
                    } else {
                        std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned()
                    };
                    if !cstr.is_null() {
                        qjs::JS_FreeCString(raw_ctx, cstr);
                    }
                    qjs::JS_FreeValue(raw_ctx, exc);
                    s
                };
                return Err(anyhow!("JS_EvalFunction threw: {msg}"));
            }
            unsafe { qjs::JS_FreeValue(raw_ctx, result) };
        } else {
            // Wrap the source in an IIFE so re-eval doesn't trip over
            // top-level const/let from a previous load. Also wrap in a
            // try/catch that promotes thrown primitives (null, undefined,
            // strings) into Error objects with a stack trace — those are
            // hostile to diagnose otherwise because QuickJS only surfaces
            // the raw value with no location info.
            let mut wrapped = Vec::with_capacity(src.len() + 128);
            wrapped.extend_from_slice(b"(function(){\ntry{\n");
            wrapped.extend_from_slice(&src);
            wrapped.extend_from_slice(
                b"\n}catch(__cm_e){\
                    if(__cm_e==null||typeof __cm_e!=='object'){\
                        var __cm_err=new Error('bundle threw non-error: '+String(__cm_e));\
                        __cm_err.original=__cm_e;\
                        throw __cm_err;\
                    }\
                    if(!__cm_e.stack){__cm_e.stack=(new Error()).stack;}\
                    throw __cm_e;\
                }\n})();",
            );
            match ctx.eval::<(), _>(wrapped.as_slice()) {
                Ok(()) => {}
                Err(e) => {
                    // Exception path: rquickjs `Error::Exception` has the
                    // message stashed in the ctx; pull it out so we can
                    // surface a useful diagnostic instead of a generic
                    // "Exception generated by QuickJS".
                    eprintln!("[carbon-mini DEBUG] rquickjs error variant: {:?}", e);
                    if matches!(e, rquickjs::Error::Exception) {
                        let exc = ctx.catch();
                        eprintln!("[carbon-mini DEBUG] is_error={} is_object={} is_null={} is_undefined={} is_string={}", exc.is_error(), exc.is_object(), exc.is_null(), exc.is_undefined(), exc.is_string());
                        // Three diagnostic strategies, tried in order:
                        //   1. Error-shaped object: read .message + .stack
                        //   2. Any other object: read .message; fall back to JSON-ish dump
                        //   3. Primitive / null: convert to string + include type tag
                        let details: String = if let Some(ex_obj) = exc.clone().into_object() {
                            let msg: Option<String> = ex_obj.get("message").ok();
                            let stack: Option<String> = ex_obj.get("stack").ok();
                            let name: Option<String> = ex_obj.get("name").ok();
                            match (name, msg, stack) {
                                (Some(n), Some(m), Some(s)) => format!("{n}: {m}\n{s}"),
                                (Some(n), Some(m), None) => format!("{n}: {m}"),
                                (None, Some(m), Some(s)) => format!("{m}\n{s}"),
                                (None, Some(m), None) => m,
                                (_, None, Some(s)) => s,
                                _ => {
                                    // Last-ditch: try the value's toString(), then a raw type tag.
                                    let as_str: Option<String> = ctx
                                        .eval::<String, _>(b"__last = arguments[0]; String(__last)".as_slice())
                                        .ok();
                                    as_str.unwrap_or_else(|| format!("{:?}", ex_obj))
                                }
                            }
                        } else {
                            // Primitive throw — get type + string form.
                            let type_str = if exc.is_null() { "null" }
                                else if exc.is_undefined() { "undefined" }
                                else if exc.is_string() { "string" }
                                else if exc.is_number() { "number" }
                                else if exc.is_bool() { "bool" }
                                else { "primitive" };
                            // exc.into_string() consumes the value; clone first.
                            let str_form: String = match exc.clone().into_string() {
                                Some(s) => s.to_string().unwrap_or_default(),
                                None => format!("{:?}", exc),
                            };
                            format!("{type_str}: {str_form}")
                        };
                        return Err(anyhow!("eval bundle threw: {details}"));
                    }
                    return Err(anyhow!("eval bundle: {e}"));
                }
            }
        }
        Ok(())
    })?;
    Ok(())
}

/// Backward-compat wrapper: read + eval in one call. Used by HMR
/// reload (which re-eval's a fresh bundle in the SAME JS context after
/// `__cm_hmr_reset` runs). Cold-start path uses the split form so the
/// disk read can overlap with window creation.
fn load_and_eval_bundle(js_ctx: &JsContext, path: &PathBuf) -> Result<()> {
    let src = read_bundle(path)?;
    eval_bundle_src(js_ctx, &src)
}

/// Raw-FFI eval helper for the snapshot spike. Evals `code` in `ctx` and
/// returns the result coerced to a String, or the exception message on error.
#[cfg(all(feature = "snapshot", windows))]
unsafe fn spike_eval(ctx: *mut rquickjs::qjs::JSContext, code: &str) -> Result<String> {
    use rquickjs::qjs;
    let mut buf = code.as_bytes().to_vec();
    buf.push(0);
    let filename = std::ffi::CString::new("<spike>").unwrap();
    let val = qjs::JS_Eval(
        ctx,
        buf.as_ptr() as *const i8,
        code.len() as _,
        filename.as_ptr(),
        qjs::JS_EVAL_TYPE_GLOBAL as i32,
    );
    if qjs::JS_IsException(val) {
        let exc = qjs::JS_GetException(ctx);
        let cstr = qjs::JS_ToCString(ctx, exc);
        let msg = if cstr.is_null() {
            "<unprintable exception>".to_string()
        } else {
            let s = std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned();
            qjs::JS_FreeCString(ctx, cstr);
            s
        };
        qjs::JS_FreeValue(ctx, exc);
        return Err(anyhow!("JS exception: {msg}"));
    }
    let cstr = qjs::JS_ToCString(ctx, val);
    let s = if cstr.is_null() {
        String::new()
    } else {
        let s = std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned();
        qjs::JS_FreeCString(ctx, cstr);
        s
    };
    qjs::JS_FreeValue(ctx, val);
    Ok(s)
}

/// Add the same intrinsic set the real runtime's context uses, on a context
/// created via `JS_NewContextRaw` (which starts empty).
#[cfg(all(feature = "snapshot", windows))]
unsafe fn spike_add_intrinsics(ctx: *mut rquickjs::qjs::JSContext) {
    use rquickjs::qjs;
    qjs::JS_AddIntrinsicBaseObjects(ctx);
    qjs::JS_AddIntrinsicEval(ctx);
    qjs::JS_AddIntrinsicRegExpCompiler(ctx);
    qjs::JS_AddIntrinsicRegExp(ctx);
    qjs::JS_AddIntrinsicJSON(ctx);
    qjs::JS_AddIntrinsicProxy(ctx);
    qjs::JS_AddIntrinsicMapSet(ctx);
    qjs::JS_AddIntrinsicTypedArrays(ctx);
    qjs::JS_AddIntrinsicPromise(ctx);
    qjs::JS_AddIntrinsicBigInt(ctx);
    qjs::JS_AddIntrinsicDate(ctx);
    qjs::JS_AddPerformance(ctx);
    qjs::JS_AddIntrinsicWeakRef(ctx);
}

/// Isolated proof-of-mechanism for the heap snapshot. Two sub-modes:
///   --snapshot-spike build   <snap>  [bundle.js]
///   --snapshot-spike restore <snap>  [probe.js]
/// `build` evaluates a representative heap (or a JS file) inside the fixed
/// arena and writes a snapshot; `restore` maps it back in a FRESH process and
/// runs a probe + GC + alloc stress to prove the heap survived and is live.
#[cfg(all(feature = "snapshot", windows))]
fn snapshot_spike(mode: &str, snap_path: &str, extra: Option<&str>) -> Result<()> {
    use rquickjs::qjs;
    eprintln!("[spike] mode={mode} exe_base={:#x}", snapshot::exe_base());

    // A synthetic module-init that touches every serializable shape: nested
    // plain objects, arrays, strings, closures with captured mutable state,
    // Map, Set, RegExp, a resolved Promise.
    const SYNTH: &str = r#"
        globalThis.__lib = (function () {
          const big = {};
          for (let i = 0; i < 20000; i++) {
            big["k" + i] = { n: i, s: "val" + i, arr: [i, i + 1, i + 2] };
          }
          const m = new Map();
          for (let i = 0; i < 5000; i++) m.set("m" + i, i * i);
          const s = new Set();
          for (let i = 0; i < 5000; i++) s.add(i);
          function makeCounter(start) { let c = start; return { inc() { return ++c; }, get() { return c; } }; }
          const counters = [];
          for (let i = 0; i < 1000; i++) counters.push(makeCounter(i * 100));
          const re = /foo(bar)+/g;
          const p = Promise.resolve(42);
          return {
            big, m, s, counters, re, p,
            sum() { let t = 0; for (const k in big) t += big[k].n; return t; },
          };
        })();
        globalThis.probe = function () {
          const L = globalThis.__lib;
          return JSON.stringify({
            keys: Object.keys(L.big).length,
            mapSize: L.m.size,
            setSize: L.s.size,
            counter0: L.counters[0].get(),
            counter999: L.counters[999].get(),
            sum: L.sum(),
            reSrc: L.re.source,
          });
        };
        "ok";
    "#;

    if mode == "build" {
        snapshot::init_arena_for_build().map_err(|e| anyhow!("init arena: {e}"))?;
        unsafe {
            let mf = snapshot::malloc_functions();
            let rt = qjs::JS_NewRuntime2(&mf, std::ptr::null_mut());
            if rt.is_null() {
                return Err(anyhow!("JS_NewRuntime2 returned null"));
            }
            qjs::JS_SetMemoryLimit(rt, 0); // arena bounds memory; no QuickJS cap
            qjs::JS_SetMaxStackSize(rt, 0); // disable stack check for the spike
            let ctx = qjs::JS_NewContextRaw(rt);
            if ctx.is_null() {
                return Err(anyhow!("JS_NewContextRaw returned null"));
            }
            spike_add_intrinsics(ctx);

            // Sanity: a trivial eval must work before the heavy synthetic heap.
            qjs::JS_UpdateStackTop(rt);
            eprintln!("[spike] sanity 1+1 -> {}", spike_eval(ctx, "1+1")?);

            // Either eval a real bundle file or the synthetic heap.
            let t_eval = Instant::now();
            if let Some(file) = extra {
                // A real app bundle is what the runtime evals at module-init.
                // It references host imports (`__cm_*`, console, native OS
                // imports) by *name*, resolved at call time — and the React
                // mount is deferred to microtasks, so a plain synchronous eval
                // performs only module-init and never calls them. We still need
                // `console` to exist (libraries log at init), so install a
                // pure-JS no-op console (kept in the arena, snapshot-safe; the
                // real console is registered after restore).
                let _ = spike_eval(
                    ctx,
                    "globalThis.console={log(){},info(){},warn(){},error(){},debug(){},trace(){}};\
                     globalThis.__cm_resolve_class=function(){return '{}';};",
                );
                if file.ends_with(".qbc.zst") || file.ends_with(".qbc") {
                    // Bytecode path — mirrors the real runtime (exec-only, no
                    // parse), so eval_ms is directly comparable to the live
                    // `bundle_evaluated` phase.
                    let raw = std::fs::read(file).with_context(|| format!("read {file}"))?;
                    let bc: Vec<u8> = if file.ends_with(".qbc.zst") {
                        let ulen =
                            u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
                        lz4_flex::decompress(&raw[4..], ulen)
                            .map_err(|e| anyhow!("lz4: {e}"))?
                    } else {
                        raw
                    };
                    let func = qjs::JS_ReadObject(
                        ctx,
                        bc.as_ptr(),
                        bc.len() as _,
                        qjs::JS_READ_OBJ_BYTECODE as i32,
                    );
                    if qjs::JS_IsException(func) {
                        return Err(anyhow!("JS_ReadObject failed"));
                    }
                    let r = qjs::JS_EvalFunction(ctx, func);
                    if qjs::JS_IsException(r) {
                        let exc = qjs::JS_GetException(ctx);
                        let cstr = qjs::JS_ToCString(ctx, exc);
                        let msg = if cstr.is_null() {
                            "<unprintable>".into()
                        } else {
                            let s =
                                std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned();
                            qjs::JS_FreeCString(ctx, cstr);
                            s
                        };
                        qjs::JS_FreeValue(ctx, exc);
                        eprintln!("[spike] bundle bytecode eval threw (continuing): {msg}");
                    }
                    qjs::JS_FreeValue(ctx, r);
                } else {
                    let src =
                        std::fs::read_to_string(file).with_context(|| format!("read {file}"))?;
                    match spike_eval(ctx, &src) {
                        Ok(_) => {}
                        Err(e) => eprintln!("[spike] bundle eval error (continuing): {e}"),
                    }
                }
            } else {
                let r = spike_eval(ctx, SYNTH)?;
                eprintln!("[spike] synth eval -> {r}");
            }
            let eval_ms = t_eval.elapsed().as_secs_f64() * 1000.0;

            qjs::JS_RunGC(rt);

            snapshot::set_rt_ctx(rt as *mut std::ffi::c_void, ctx as *mut std::ffi::c_void);
            let used = snapshot::used_bytes();
            let live = snapshot::live_bytes();
            let t_w = Instant::now();
            let path = std::path::PathBuf::from(snap_path);
            let file_len = snapshot::write_snapshot(&path).map_err(|e| anyhow!("write: {e}"))?;
            let write_ms = t_w.elapsed().as_secs_f64() * 1000.0;
            // Also write the uncompressed mmap form (for the lazy-restore path).
            let raw_path = path.with_extension("raw");
            let raw_len = snapshot::write_snapshot_mmap(&raw_path)
                .map_err(|e| anyhow!("write mmap: {e}"))?;
            eprintln!(
                "[spike] BUILD: eval={eval_ms:.1}ms  arena_used={:.2}MB  live={:.2}MB  \
                 lz4_file={:.2}MB  write={write_ms:.1}ms  raw_file={:.2}MB",
                used as f64 / 1e6,
                live as f64 / 1e6,
                file_len as f64 / 1e6,
                raw_len as f64 / 1e6,
            );
            // Probe before exit to show the live heap is correct pre-snapshot.
            if extra.is_none() {
                eprintln!("[spike] pre-snapshot probe -> {}", spike_eval(ctx, "probe()")?);
            }
        }
        Ok(())
    } else if mode == "restore" || mode == "restore-mmap" {
        let path = std::path::PathBuf::from(snap_path);
        let t_r = Instant::now();
        let restored = if mode == "restore-mmap" {
            let raw = path.with_extension("raw");
            snapshot::restore_mmap(&raw).map_err(|e| anyhow!("restore-mmap: {e}"))?
        } else {
            snapshot::restore_from_file(&path).map_err(|e| anyhow!("restore: {e}"))?
        };
        let restore_ms = t_r.elapsed().as_secs_f64() * 1000.0;
        unsafe {
            let rt = restored.rt as *mut qjs::JSRuntime;
            let ctx = restored.ctx as *mut qjs::JSContext;
            qjs::JS_UpdateStackTop(rt);
            eprintln!("[spike] RESTORE ({mode}): returned in {restore_ms:.2}ms");
            // First full heap-touch — for the mmap path this is where pages
            // actually fault in from the file; measured separately so we can
            // see upfront-restore vs deferred page-in.
            let t_touch = Instant::now();
            qjs::JS_RunGC(rt);
            let _ = spike_eval(ctx, "Object.keys(globalThis).length")?;
            let touch_ms = t_touch.elapsed().as_secs_f64() * 1000.0;
            eprintln!("[spike] first full heap-touch (GC + walk): {touch_ms:.2}ms");

            // Generic heap-integrity probe (works for any snapshot): the global
            // object's shape survived, the GC can walk the whole restored graph,
            // and the allocator serves fresh allocations from the restored state.
            let keys = spike_eval(ctx, "Object.keys(globalThis).length")?;
            eprintln!("[spike] globalThis key count -> {keys}");
            qjs::JS_RunGC(rt);
            let keys2 = spike_eval(ctx, "Object.keys(globalThis).length")?;
            eprintln!("[spike] globalThis key count (after full GC) -> {keys2}");
            let stress = spike_eval(
                ctx,
                "(function(){let a=[];for(let i=0;i<50000;i++)a.push({i,s:'x'+i});\
                 let t=0;for(const o of a)t+=o.i;return t;})()",
            )?;
            eprintln!("[spike] alloc stress sum -> {stress} (expect 1249975000)");

            // Synthetic-snapshot extras (no-op for real bundles).
            if spike_eval(ctx, "typeof globalThis.probe")?.trim() == "function" {
                eprintln!("[spike] probe() -> {}", spike_eval(ctx, "probe()")?);
                eprintln!(
                    "[spike] counters[0].inc() -> {} (expect 1)",
                    spike_eval(ctx, "globalThis.__lib.counters[0].inc()")?
                );
            }
            // Optional caller-supplied probe file.
            if let Some(probe_file) = extra {
                if std::path::Path::new(probe_file).exists() {
                    let src = std::fs::read_to_string(probe_file)
                        .with_context(|| format!("read {probe_file}"))?;
                    eprintln!("[spike] custom probe -> {}", spike_eval(ctx, &src)?);
                }
            }
        }
        eprintln!("[spike] RESTORE OK");
        Ok(())
    } else {
        Err(anyhow!("unknown spike mode '{mode}' (use build|restore)"))
    }
}

/// Eval a bundle file (bytecode `.qbc.zst`/`.qbc` or `.js` source) into a raw
/// context. Used by the snapshot build path. Errors during eval are returned
/// (the caller decides whether a partial heap is still useful).
#[cfg(all(feature = "snapshot", windows))]
unsafe fn snapshot_eval_bundle_file(
    ctx: *mut rquickjs::qjs::JSContext,
    file: &std::path::Path,
) -> Result<()> {
    use rquickjs::qjs;
    let path_str = file.to_string_lossy();
    if path_str.ends_with(".qbc.zst") || path_str.ends_with(".qbc") {
        let raw = std::fs::read(file).with_context(|| format!("read {}", file.display()))?;
        let bc: Vec<u8> = if path_str.ends_with(".qbc.zst") {
            let ulen = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
            lz4_flex::decompress(&raw[4..], ulen).map_err(|e| anyhow!("lz4: {e}"))?
        } else {
            raw
        };
        let func = qjs::JS_ReadObject(
            ctx,
            bc.as_ptr(),
            bc.len() as _,
            qjs::JS_READ_OBJ_BYTECODE as i32,
        );
        if qjs::JS_IsException(func) {
            return Err(anyhow!("JS_ReadObject failed"));
        }
        let r = qjs::JS_EvalFunction(ctx, func);
        let threw = qjs::JS_IsException(r);
        if threw {
            let exc = qjs::JS_GetException(ctx);
            let cstr = qjs::JS_ToCString(ctx, exc);
            let msg = if cstr.is_null() {
                "<unprintable>".to_string()
            } else {
                let s = std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned();
                qjs::JS_FreeCString(ctx, cstr);
                s
            };
            qjs::JS_FreeValue(ctx, exc);
            qjs::JS_FreeValue(ctx, r);
            return Err(anyhow!("bundle eval threw: {msg}"));
        }
        qjs::JS_FreeValue(ctx, r);
        Ok(())
    } else {
        let src = std::fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
        spike_eval(ctx, &src).map(|_| ())
    }
}

/// `--snapshot-build <project-dir>`: evaluate the app bundle purely for
/// module-init (with the mount deferred via `__cm_defer_mount`) inside the
/// fixed-address snapshot arena, then write the heap image next to the bundle
/// as `dist/bundle.cmsnap.raw` + `.meta`. Window-less; exits when done. The
/// normal startup path then memory-maps that image instead of re-evaluating
/// the bundle.
#[cfg(all(feature = "snapshot", windows))]
fn snapshot_build_app(project_dir: &std::path::Path) -> Result<()> {
    use rquickjs::qjs;
    let t0 = Instant::now();
    // Prefer bytecode (matches what the runtime evals) > source.
    let cand = [
        project_dir.join("dist/bundle.qbc.zst"),
        project_dir.join("dist/bundle.qbc"),
        project_dir.join("dist/bundle.js"),
    ];
    let bundle = cand
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| anyhow!("no dist/bundle.* found under {}", project_dir.display()))?;

    snapshot::init_arena_for_build().map_err(|e| anyhow!("init arena: {e}"))?;
    unsafe {
        let mf = snapshot::malloc_functions();
        let rt = qjs::JS_NewRuntime2(&mf, std::ptr::null_mut());
        if rt.is_null() {
            return Err(anyhow!("JS_NewRuntime2 null"));
        }
        qjs::JS_SetMemoryLimit(rt, 0);
        qjs::JS_SetMaxStackSize(rt, 0);
        qjs::JS_SetGCThreshold(rt, 64 * 1024);
        let ctx = qjs::JS_NewContextRaw(rt);
        if ctx.is_null() {
            return Err(anyhow!("JS_NewContextRaw null"));
        }
        spike_add_intrinsics(ctx);
        qjs::JS_UpdateStackTop(rt);

        // Prelude: defer the mount, and stand in a pure-JS console (the real
        // rquickjs console is registered after restore; module-init logs at
        // build time are intentionally dropped). The bundle's `render(<App/>)`
        // sees `__cm_defer_mount` and stashes `__cm_run_deferred_mount`.
        // Prelude: defer the mount + stand in for the host imports that
        // module-init touches. React apps mount their visible tree through
        // `render()` (deferred), but carbon-dom-shim creates `document.body` at
        // install time and the bundle reads OS/app facts at module-init.
        //
        // CRITICAL: the VALUE-returning stubs must return EXACTLY what the real
        // native host fns return, because apps compute module-level constants
        // from them (e.g. terax: `const IS_WINDOWS = platform() === "windows"`).
        // Those constants are baked into the snapshot, so a stub that returns a
        // different value (e.g. "win32" vs "windows") silently corrupts app
        // behaviour after restore. The build runs the same binary on the same
        // machine, so we inject the real values here.
        let platform = if cfg!(target_os = "windows") { "windows" }
            else if cfg!(target_os = "macos") { "macos" }
            else if cfg!(target_os = "linux") { "linux" } else { "unknown" };
        let arch = if cfg!(target_arch = "x86_64") { "x86_64" }
            else if cfg!(target_arch = "aarch64") { "aarch64" }
            else if cfg!(target_arch = "x86") { "x86" } else { "unknown" };
        let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let pd = project_dir.to_path_buf();
        let (app_name, app_version) = read_app_metadata(&pd);
        let (win_w, win_h, _dec) = read_window_cfg(&pd);
        // JSON-encode so backslashes/quotes in paths are escaped safely.
        let j = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
        let prelude = format!(
            r#"
            globalThis.__cm_defer_mount = true;
            globalThis.console = {{ log(){{}}, info(){{}}, warn(){{}}, error(){{}}, debug(){{}}, trace(){{}} }};
            (function () {{
              const noop = function () {{}};
              // Host imports the bundle may CALL at module-init. The dispatch
              // callbacks and JS-managed state (__cm_node_id_seq, …) are owned by
              // the bundle and must NOT be stubbed.
              const hostFns = [
                "__cm_create_node","__cm_set_prop","__cm_set_text","__cm_insert_node",
                "__cm_remove_node","__cm_set_root","__cm_request_paint","__cm_reset_paint_props",
                "__cm_set_scroll_y","__cm_broadcast_resize","__cm_load_system_font","__cm_canvas",
                "__cm_test","__cm_invoke","__cm_invoke_has",
                "__cm_autostart_enable","__cm_autostart_disable","__cm_autostart_is_enabled",
                "__cm_proc_relaunch_self","__cm_shell_open","__cm_shell_reveal",
                "__cm_pty_spawn","__cm_pty_write","__cm_pty_read","__cm_pty_resize","__cm_pty_close",
                "__cm_window_close","__cm_window_focus","__cm_window_hide","__cm_window_show",
                "__cm_window_minimize","__cm_window_maximize","__cm_window_unmaximize",
                "__cm_window_toggle_maximize","__cm_window_is_focused","__cm_window_is_maximized",
                "__cm_window_is_minimized","__cm_window_set_title","__cm_window_set_fullscreen",
                "__cm_window_start_drag","__cm_window_open"
              ];
              for (const n of hostFns) {{
                if (typeof globalThis[n] !== "function") globalThis[n] = noop;
              }}
              // Value-returning host fns — REAL values (must match native).
              globalThis.__cm_resolve_class = function () {{ return "{{}}"; }};
              globalThis.__cm_layout_box = function () {{
                return JSON.stringify({{ x:0, y:0, width:0, height:0, top:0, left:0, right:0, bottom:0 }});
              }};
              globalThis.__cm_os_platform = function () {{ return {platform}; }};
              globalThis.__cm_os_arch = function () {{ return {arch}; }};
              globalThis.__cm_fs_home_dir = function () {{ return {home}; }};
              globalThis.__cm_app_name = function () {{ return {app_name}; }};
              globalThis.__cm_app_version = function () {{ return {app_version}; }};
              globalThis.__cm_window_label = function () {{ return "main"; }};
              globalThis.__cm_window_opts_json = function () {{ return "{{}}"; }};
              globalThis.__cm_window_device_pixel_ratio = function () {{ return 1; }};
              globalThis.__cm_window_inner_width = function () {{ return {win_w}; }};
              globalThis.__cm_window_inner_height = function () {{ return {win_h}; }};
            }})();
            "#,
            platform = j(platform),
            arch = j(arch),
            home = j(&home),
            app_name = j(&app_name),
            app_version = j(&app_version),
            win_w = win_w as i64,
            win_h = win_h as i64,
        );
        spike_eval(ctx, &prelude)?;

        match snapshot_eval_bundle_file(ctx, &bundle) {
            Ok(()) => {}
            Err(e) => eprintln!("[carbon-mini snapshot-build] bundle eval error (continuing): {e}"),
        }

        // Did the framework defer the mount? If not, the snapshot won't be
        // restorable into a rendered app — warn loudly.
        let deferred = spike_eval(ctx, "typeof globalThis.__cm_run_deferred_mount")?;
        if deferred.trim() != "function" {
            eprintln!(
                "[carbon-mini snapshot-build] WARNING: __cm_run_deferred_mount not set \
                 (the bundle didn't call render() under __cm_defer_mount, or it mounted \
                 synchronously). Restore may show a blank window."
            );
        }

        qjs::JS_RunGC(rt);
        snapshot::set_rt_ctx(rt as *mut std::ffi::c_void, ctx as *mut std::ffi::c_void);

        let raw_path = project_dir.join("dist/bundle.cmsnap.raw");
        let raw_len = snapshot::write_snapshot_mmap(&raw_path).map_err(|e| anyhow!("write: {e}"))?;
        let build_ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "[carbon-mini snapshot-build] {} -> {} ({:.2} MB heap, {:.2} MB live) in {build_ms:.0}ms",
            bundle.display(),
            raw_path.display(),
            raw_len as f64 / 1e6,
            snapshot::live_bytes() as f64 / 1e6,
        );
    }
    Ok(())
}

/// Create a fresh JS runtime + context with the standard carbon-mini intrinsic
/// set. Used by the normal (non-snapshot) cold path and as the snapshot-restore
/// fallback.
fn stack_size_bytes() -> usize {
    std::env::var("CARBON_STACK_MB")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .map(|mb| mb * 1024 * 1024)
        .unwrap_or(4 * 1024 * 1024)
}

fn create_fresh_runtime() -> Result<(JsRuntime, JsContext)> {
    let js_rt = JsRuntime::new().map_err(|e| anyhow!("js runtime: {e}"))?;
    js_rt.set_gc_threshold(64 * 1024);
    js_rt.set_memory_limit(256 * 1024 * 1024);
    js_rt.set_max_stack_size(stack_size_bytes());
    let js_ctx = JsContext::builder()
        .with::<intrinsic::Eval>()
        .with::<intrinsic::RegExp>()
        .with::<intrinsic::Json>()
        .with::<intrinsic::MapSet>()
        .with::<intrinsic::TypedArrays>()
        .with::<intrinsic::Date>()
        .with::<intrinsic::Promise>()
        .with::<intrinsic::BigInt>()
        .with::<intrinsic::Performance>()
        .with::<intrinsic::Proxy>()
        .with::<intrinsic::WeakRef>()
        .build(&js_rt)
        .map_err(|e| anyhow!("js ctx: {e}"))?;
    Ok((js_rt, js_ctx))
}

/// Try to restore a prebuilt startup heap snapshot for `project_dir`. Returns
/// the wrapped runtime + context on success; `None` (cold path) if disabled,
/// absent, or restore fails. Gated behind `CARBON_SNAPSHOT` so it's strictly
/// opt-in.
#[cfg(all(feature = "snapshot", windows))]
fn try_restore_snapshot(project_dir: &std::path::Path, t0: Instant) -> Option<(JsRuntime, JsContext)> {
    // OPT-IN (CARBON_SNAPSHOT=1). The snapshot restores a heap whose module-init
    // ran at BUILD time with a stand-in environment; apps that derive state from
    // host fns at module-init (e.g. terax: terminal/explorer/stores) can behave
    // differently than a cold start, so auto-on is unsafe for arbitrary apps.
    // Left opt-in until a build-time real-host-environment pass lands. Verified
    // safe for simple React apps (see examples/react).
    if std::env::var_os("CARBON_SNAPSHOT").is_none() {
        return None;
    }
    let raw = project_dir.join("dist/bundle.cmsnap.raw");
    let meta = raw.with_extension("meta");
    if !raw.exists() || !meta.exists() {
        return None;
    }
    // Staleness guard: only use the snapshot if it is at least as new as the
    // bundle it was built from. A bundle rebuilt without a matching snapshot
    // (e.g. an HMR/edit cycle) is therefore NEVER restored from a stale image —
    // we fall back to evaluating the fresh bundle. (The code fingerprint already
    // rejects snapshots from a different binary.)
    let snap_mtime = std::fs::metadata(&raw).and_then(|m| m.modified()).ok();
    let bundle_mtime = ["dist/bundle.qbc.zst", "dist/bundle.qbc", "dist/bundle.js"]
        .iter()
        .filter_map(|p| std::fs::metadata(project_dir.join(p)).and_then(|m| m.modified()).ok())
        .max();
    if let (Some(s), Some(b)) = (snap_mtime, bundle_mtime) {
        if s < b {
            eprintln!("[carbon-mini] snapshot is older than the bundle; using cold path");
            return None;
        }
    }
    match snapshot::restore_mmap(&raw) {
        Ok(r) => unsafe {
            let rt_ptr = r.rt as *mut rquickjs::qjs::JSRuntime;
            let ctx_ptr = r.ctx as *mut rquickjs::qjs::JSContext;
            // Re-arm the runtime for this thread/process: anchor the stack-
            // overflow check at the current (shallow) frame before any JS runs.
            rquickjs::qjs::JS_SetMaxStackSize(rt_ptr, stack_size_bytes() as u64);
            rquickjs::qjs::JS_UpdateStackTop(rt_ptr);
            // Wrap the raw runtime/context back into the high-level API (installs
            // a fresh Opaque + the rquickjs RustClass/RustFunction classes).
            let rt = match JsRuntime::from_raw_restored(rt_ptr) {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[carbon-mini] from_raw_restored failed: {e}");
                    return None;
                }
            };
            rt.set_gc_threshold(64 * 1024);
            let ctx_nn = std::ptr::NonNull::new(ctx_ptr)?;
            let ctx = JsContext::from_raw(ctx_nn, rt.clone());
            timing_log("snapshot_restored", t0);
            Some((rt, ctx))
        },
        Err(e) => {
            eprintln!("[carbon-mini] snapshot restore unavailable ({e}); using cold path");
            None
        }
    }
}

#[cfg(not(all(feature = "snapshot", windows)))]
fn try_restore_snapshot(_project_dir: &std::path::Path, _t0: Instant) -> Option<(JsRuntime, JsContext)> {
    None
}

/// The message + location of the most recent panic caught by the event
/// loop's `catch_unwind`. The panic hook (installed in `main`) fills this in
/// as the panic propagates; the catch site reads it to log / surface a useful
/// message instead of an opaque "thread panicked". Behind a Mutex so the hook
/// (which can run on any thread) and the main thread don't race.
static LAST_PANIC: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Install a process-wide panic hook that records the panic's message +
/// location into `LAST_PANIC` and echoes it to stderr. Paired with the
/// `catch_unwind` around the event-loop body: the hook captures the *why*
/// (the default hook's rich message) before the stack unwinds, and the catch
/// site keeps the app alive. Without the hook, `catch_unwind` only hands back
/// an opaque `Box<dyn Any>` that rarely carries the message.
fn install_panic_hook() {
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

fn main() -> Result<()> {
    prof_zone!("main");
    let t0 = Instant::now();
    let _ = START.set(t0);

    // Crash resilience: capture panics with a hook so the event loop's
    // catch_unwind can keep the window alive and log a useful message
    // instead of the process vanishing. Installed as early as possible.
    install_panic_hook();

    prof_zone!("args_resolve");
    let args: Vec<String> = std::env::args().collect();

    // Build-time mode: compile a JS bundle to QuickJS bytecode and exit.
    if args.len() >= 4 && args[1] == "--compile-bundle" {
        return compile_bundle(&args[2], &args[3]);
    }

    // Snapshot spike (feature-gated proof of mechanism, isolated from startup):
    //   --snapshot-spike <build|restore> <snapshot-path> [bundle-or-probe.js]
    #[cfg(all(feature = "snapshot", windows))]
    if args.len() >= 4 && args[1] == "--snapshot-spike" {
        return snapshot_spike(&args[2], &args[3], args.get(4).map(|s| s.as_str()));
    }

    // Build-time mode: produce a startup heap snapshot for an app.
    //   --snapshot-build <project-dir>
    // Dispatched on ANY build (not just feature builds) so the CLI can call it
    // unconditionally — a runtime without the `snapshot` feature just exits
    // cleanly instead of mistaking the flag for a project dir and launching.
    if args.len() >= 3 && args[1] == "--snapshot-build" {
        #[cfg(all(feature = "snapshot", windows))]
        {
            let dir = std::path::Path::new(&args[2])
                .canonicalize()
                .with_context(|| format!("project dir {}", args[2]))?;
            return snapshot_build_app(&dir);
        }
        #[cfg(not(all(feature = "snapshot", windows)))]
        {
            eprintln!(
                "[carbon-mini] --snapshot-build: this runtime was built without the \
                 `snapshot` feature; nothing to do."
            );
            return Ok(());
        }
    }

    // Test hook: auto-exit after N ms so a launched app exits cleanly (and its
    // stderr/timing logs flush) without needing a force-kill.
    if let Some(ms) = std::env::var("CARBON_TEST_EXIT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            std::process::exit(0);
        });
    }

    // Parse positional project dir + flags. --dev enables in-process HMR:
    // a background thread polls the bundle file's mtime and posts a
    // UserEvent::ReloadBundle when it changes; the event-loop handler
    // re-evals the new bundle in the SAME rquickjs context (so the JS-side
    // __hmr_state Map survives) and rebuilds the scene.
    //
    // --window-label <name> + --window-opts <json>: spawned by
    // `__cm_window_open(label, optsJson)` to create a second native
    // window. The child process runs the SAME bundle as the parent;
    // the bundle reads its label via `__cm_window_label()` and renders
    // the appropriate page. opts are forwarded as a free-form JSON
    // string accessible via `__cm_window_opts_json()`. This is the v1
    // multi-window mechanism — process-per-window, naturally isolated,
    // no main-loop refactor required.
    let mut dev_mode = false;
    let mut positional: Option<PathBuf> = None;
    let mut window_label: String = "main".to_string();
    let mut window_opts_json: String = "{}".to_string();
    let mut iter = args.iter().skip(1).peekable();
    while let Some(a) = iter.next() {
        if a == "--dev" {
            dev_mode = true;
        } else if a == "--window-label" {
            if let Some(v) = iter.next() { window_label = v.clone(); }
        } else if a == "--window-opts" {
            if let Some(v) = iter.next() { window_opts_json = v.clone(); }
        } else if !a.starts_with("--") {
            if positional.is_none() {
                positional = Some(PathBuf::from(a));
            }
        }
    }
    // Mirror label + opts into static slots so JS-side host imports
    // resolve them via `__cm_window_label()` / `__cm_window_opts_json()`.
    crate::native::window::set_window_label(window_label.clone());
    crate::native::window::set_window_opts_json(window_opts_json.clone());
    let project_dir = positional.unwrap_or_else(|| std::env::current_dir().unwrap());
    let project_dir = project_dir
        .canonicalize()
        .with_context(|| format!("project dir {}", project_dir.display()))?;

    // Stash project_dir in the paint module's thread-local so background
    // images referenced by relative path resolve correctly.
    paint::set_project_dir(project_dir.clone());
    // paint can't depend on async_image directly (see paint's
    // set_async_image_resolver doc comment) — wire the real implementation
    // in via the hook instead.
    paint::set_async_image_resolver(async_image::get);

    // Locate JS bundle. Prefer zstd-compressed bytecode > raw bytecode > source.
    // The build/CLI emits .qbc.zst when [runtime] bytecode = true in carbon.toml.
    let bundle_candidates = [
        project_dir.join("dist/bundle.qbc.zst"),
        project_dir.join("dist/bundle.qbc"),
        project_dir.join("dist/bundle.js"),
        project_dir.join("counter.js"),
        project_dir.join("bundle.qbc.zst"),
        project_dir.join("bundle.qbc"),
        project_dir.join("bundle.js"),
    ];
    let bundle_path = bundle_candidates.iter().find(|p| p.exists()).cloned();

    // Vendor bundle (produced by `carbon` split builds): all node_modules
    // compiled ONCE into dist/vendor.js, which populates a global module
    // registry + a `require` shim. Eval'd once below, before the app bundle,
    // and persists across HMR app re-evals (the --dev watcher only watches the
    // app bundle). Absent on normal/single-bundle builds → this is a no-op.
    let vendor_path = {
        let v = project_dir.join("dist/vendor.js");
        if v.exists() { Some(v) } else { None }
    };
    timing_log("args_resolved", t0);

    // Disk read + lz4 decompression of the bundle is independent of window
    // creation — both are heavy operations. Run the read on a worker
    // thread overlapped with the ~170 ms `tao` window setup; we'll join
    // when we're ready to eval. Nets ~10-20 ms off cold start at the
    // cost of one short-lived OS thread.
    let bundle_read_handle: Option<std::thread::JoinHandle<Result<BundleSrc>>> =
        bundle_path.as_ref().map(|p| {
            let p = p.clone();
            std::thread::spawn(move || read_bundle(&p))
        });

    prof_zone!("window_init");
    // Mark the process PER-MONITOR-DPI-AWARE (v2) on Windows BEFORE we create
    // the event loop / window. tao then reports the real scale_factor (e.g.
    // 1.25 on a 125% laptop panel) and a PHYSICAL inner_size, and Windows
    // no longer bitmap-upscales our buffer. The paint pipeline lays out in
    // LOGICAL px and scales to physical at draw time (root transform +
    // TextEngine::scale), so text/borders/icons render crisp at native
    // resolution and match a DPI-aware webview (wry/Tauri) 1:1.
    #[cfg(target_os = "windows")]
    unsafe {
        // Avoid pulling in the winapi crate — inline the linker decl.
        // Equivalent to declaring SetProcessDpiAwarenessContext from
        // user32.dll and passing DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
        extern "system" {
            fn SetProcessDpiAwarenessContext(value: isize) -> i32;
        }
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. Returns 0 on
        // failure (older Windows without v2) — best-effort; we then fall
        // back to whatever awareness the process default / manifest gives.
        if SetProcessDpiAwarenessContext(-4) == 0 {
            // PER_MONITOR_AWARE_V2 unavailable (pre-1703) — try plain
            // PER_MONITOR_AWARE (-3), then system-aware (-2).
            if SetProcessDpiAwarenessContext(-3) == 0 {
                let _ = SetProcessDpiAwarenessContext(-2);
            }
        }
    }
    let event_loop: EventLoop<UserEvent> =
        EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    timing_log("event_loop_built", t0);

    let (mut init_w, mut init_h, mut decorated) = read_window_cfg(&project_dir);
    // Window-opts override: child windows spawned via __cm_window_open
    // pass their requested title/width/height/decorated through this
    // JSON blob. Parsing here lets a single carbon.toml ship one app
    // bundle that paints differently per-window.
    let mut win_title: String = "carbon-mini".to_string();
    let mut win_resizable = true;
    if window_opts_json != "{}" {
        if let Ok(opts) = serde_json::from_str::<serde_json::Value>(&window_opts_json) {
            if let Some(t) = opts.get("title").and_then(|v| v.as_str()) { win_title = t.to_string(); }
            if let Some(w) = opts.get("width").and_then(|v| v.as_f64()) { init_w = w; }
            if let Some(h) = opts.get("height").and_then(|v| v.as_f64()) { init_h = h; }
            if let Some(d) = opts.get("decorated").and_then(|v| v.as_bool()) { decorated = d; }
            if let Some(r) = opts.get("resizable").and_then(|v| v.as_bool()) { win_resizable = r; }
        }
    }
    let window = WindowBuilder::new()
        .with_title(&win_title)
        .with_inner_size(LogicalSize::new(init_w, init_h))
        .with_min_inner_size(LogicalSize::new(320.0, 240.0))
        .with_resizable(win_resizable)
        .with_decorations(decorated)
        .with_visible(false)
        .build(&event_loop)
        .context("building window")?;
    let window = Rc::new(window);
    // Seed the system-theme slot from tao's initial reading. JS
    // queries via __cm_os_theme(); ThemeChanged events update it.
    {
        use tao::window::Theme;
        let theme = match window.theme() {
            Theme::Dark => "dark",
            _ => "light",
        };
        os_theme::set(theme);
    }
    timing_log("window_built", t0);

    // softbuffer context bound to the window
    let context = softbuffer::Context::new(window.clone())
        .map_err(|e| anyhow!("softbuffer ctx: {e}"))?;
    timing_log("softbuffer_ctx", t0);
    let mut surface = softbuffer::Surface::new(&context, window.clone())
        .map_err(|e| anyhow!("softbuffer surface: {e}"))?;
    timing_log("softbuffer_ready", t0);

    // Scene graph (shared between JS host imports and the paint thread).
    let scene = Arc::new(Mutex::new(Scene::new()));
    timing_log("scene_created", t0);

    // Lazy text engine — only loads font on first text paint.
    let text_engine = Rc::new(RefCell::new(text::TextEngine::new()));
    timing_log("text_engine_created", t0);
    // Resolve font: prefer user's <project>/assets/font.ttf if present, else the
    // embedded Latin subset baked in at build time.
    text_engine.borrow_mut().try_load_user_font(&project_dir);
    timing_log("font_user_resolved", t0);
    text_engine.borrow_mut().preload();
    timing_log("font_preloaded", t0);

    // Build JS runtime + register host imports — or RESTORE a prebuilt heap
    // snapshot (CARBON_SNAPSHOT=1, snapshot feature). The snapshot already
    // contains the module-init heap (React + all libraries + the app's
    // components, with the mount deferred); restoring memory-maps it back in
    // instead of re-evaluating the bundle. `restored` gates the eval/mount
    // path below: a fresh runtime evals the bundle, a restored one just runs
    // the deferred mount (after host imports are registered, same as a cold
    // start would have them before eval).
    let (js_rt, js_ctx, restored) = match try_restore_snapshot(&project_dir, t0) {
        Some((rt, ctx)) => (rt, ctx, true),
        None => {
            let (rt, ctx) = create_fresh_runtime()?;
            (rt, ctx, false)
        }
    };
    timing_log("js_runtime_ready", t0);

    register_host_imports(&js_ctx, scene.clone(), proxy.clone(), text_engine.clone())?;
    timing_log("host_imports_registered", t0);

    // Native OS integration imports — fs, process, dialog, shell,
    // clipboard, notification, autostart, window_state, keychain, net.
    // Synchronous OS calls + an async tokio runtime for networking,
    // with results posted back via UserEvent.
    // `tlog` is this binary's own — see the PhaseLogger note in carbon-os.
    native::register_all(&js_ctx, proxy.clone(), &tlog)?;
    timing_log("native_registered", t0);

    // Plugin loader bootstrap. Order is intentional:
    //   1. Mark THIS thread as the JS thread so `carbon_js_*` host exports
    //      can gate on it.
    //   2. Install the EventLoopProxy into the host_exports global so
    //      `host_push_event` / `host_request_paint` can route from worker
    //      threads.
    //   3. Build a HostCarbonApp pinned for the runtime's lifetime. Plugins
    //      keep `*mut HostCarbonApp` into this; it MUST not move.
    //   4. Install the `__carbon_on_event` JS dispatcher BEFORE registering
    //      plugins, so a register that immediately dispatches an event
    //      doesn't drop it.
    //   5. Load plugins from carbon.toml [plugins] (no-op if missing).
    //   6. Capture the registry; dispatch_register runs after the bundle
    //      eval below so plugins can install globals on top of an already-
    //      live runtime.
    host_exports::mark_current_thread_as_js();
    host_exports::install_event_loop_proxy(proxy.clone());

    let initial_size = window.inner_size();
    let initial_scale = window.scale_factor();
    // Mirror initial size + scale into the @/native/window state slots so
    // JS-side `window.innerWidth/Height` and `devicePixelRatio` resolve
    // correctly on the first paint — without this they'd return 0
    // (the OnceLock default) until the first Resized event fires.
    // set_inner_size stores PHYSICAL px; the native layer divides by the
    // scale factor so JS `window.innerWidth/Height` report LOGICAL (CSS) px
    // and `devicePixelRatio` reports the scale.
    crate::native::window::set_inner_size(initial_size.width, initial_size.height);
    crate::native::window::set_scale_factor(initial_scale);
    // HOST_WINDOW_SIZE holds the LOGICAL (CSS-px) viewport — the off-thread
    // compute_layout calls (scroll / __cm_layout_box / dump_tree) and
    // getBoundingClientRect all work in CSS px. The paint loop scales up to
    // the physical buffer; keeping layout logical means "h-10" is 40 CSS px
    // on any DPI, matching a browser / DPI-aware webview.
    let sf = (initial_scale as f32).max(0.1);
    if let Ok(mut g) = HOST_WINDOW_SIZE.lock() {
        *g = (initial_size.width as f32 / sf, initial_size.height as f32 / sf);
    }
    // Pull app metadata from carbon.toml if present. This is intentionally
    // best-effort — apps without carbon.toml still get a valid CarbonApp
    // (with empty strings) and the loader simply finds no plugins to load.
    let (cfg_app_name, cfg_app_version) = read_app_metadata(&project_dir);
    crate::native::app::set_metadata(&cfg_app_name, &cfg_app_version);
    let mut host_app = host_exports::HostCarbonAppStorage::new(
        &cfg_app_name,
        &cfg_app_version,
        &project_dir.to_string_lossy(),
        initial_size.width.max(1),
        initial_size.height.max(1),
    );
    // The QuickJS JSContext* serves as the opaque CarbonJSContext*.
    let js_ctx_raw = js_ctx.with(|ctx| ctx.as_raw().as_ptr());
    host_app.set_js_context(js_ctx_raw as *mut host_exports::CarbonJSContext);
    // Wire raw_window_handle / raw_display_handle so GPU plugins (carbon-canvas,
    // future wgpu plugins) can construct a wgpu surface. The fields hold raw
    // OS handles (HWND on Windows, NSView on macOS, X11/Wayland handles on
    // Linux) per the carbon_plugin.h contract. Populated per-platform below;
    // platforms we haven't wired keep the default null pointers.
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        let hwnd = window.hwnd() as *mut std::ffi::c_void;
        // Display handle on Windows is implicitly the desktop; rwh exposes
        // it as an empty marker, so a null pointer is the right value here
        // (consumers know to construct `RawDisplayHandle::Windows(_)` from
        // it without dereferencing).
        host_app.set_raw_window_handles(hwnd, core::ptr::null_mut());
    }

    install_carbon_event_dispatcher(&js_ctx)?;
    timing_log("carbon_dispatcher_installed", t0);

    let app_ptr = host_app.raw();
    let plugin_entries = read_plugins_section(&project_dir);
    let mut plugin_registry =
        plugin_loader::PluginRegistry::load_from_config(&plugin_entries, &project_dir, app_ptr)
            .unwrap_or_else(|e| {
                eprintln!("[carbon-mini-plugin] registry init failed: {e:#}");
                plugin_loader::PluginRegistry::new(app_ptr)
            });
    timing_log("plugins_loaded", t0);

    maybe_register_image(&js_ctx, &project_dir)?;
    timing_log("image_registered", t0);

    // Web Audio API — opt-in via CARBON_MINI_AUDIO=1 or [runtime] audio = true
    // in carbon.toml. No-op when disabled (zero cold-start cost).
    maybe_register_audio(&js_ctx, &project_dir)?;
    timing_log("audio_registered", t0);

    if restored {
        // Snapshot restored: the module-init heap is already live (no vendor /
        // bundle eval). Run the mount that was deferred at build time, now that
        // the real host imports + console are registered. This performs React's
        // initial render into the fresh (empty) scene in this session.
        let _ = bundle_read_handle.map(|h| h.join()); // join the (now unused) pre-read
        let mount_res = js_ctx.with(|ctx| -> rquickjs::Result<bool> {
            let g = ctx.globals();
            match g.get::<_, Function>("__cm_run_deferred_mount") {
                Ok(f) => {
                    f.call::<_, ()>(())?;
                    Ok(true)
                }
                Err(_) => Ok(false),
            }
        });
        match mount_res {
            Ok(true) => {}
            Ok(false) => {
                eprintln!("[carbon-mini] restored heap has no __cm_run_deferred_mount; blank window likely");
                install_hardcoded_scene(&scene);
            }
            Err(e) => {
                eprintln!("[carbon-mini] deferred mount threw: {e}");
            }
        }
        timing_log("deferred_mount_done", t0);
        if std::env::var_os("CARBON_MINI_TIMING").is_some() {
            let n = scene.lock().map(|s| s.nodes.len()).unwrap_or(0);
            eprintln!("[carbon-mini-timing] restored_scene_nodes={n}");
        }
    } else {
        // Eval the vendor bundle FIRST (if present) so the app bundle's `require`
        // calls resolve against the populated registry.
        if let Some(vp) = &vendor_path {
            match read_bundle(vp).and_then(|src| eval_bundle_src(&js_ctx, &src)) {
                Ok(()) => timing_log("vendor_evaluated", t0),
                Err(e) => eprintln!("[carbon-mini] vendor load failed: {e:#}"),
            }
        }

        if let Some(path) = &bundle_path {
            // Join the pre-read worker. If the read finished while we were
            // building the window + initializing JS, this is a no-op join.
            // If the worker hasn't finished, we block (rare — read+lz4 on a
            // ~300 KB file is normally <10 ms vs. window's ~170 ms).
            let read_result: Result<BundleSrc> = bundle_read_handle
                .map(|h| h.join().map_err(|_| anyhow!("bundle read worker panicked"))?)
                .unwrap_or_else(|| Err(anyhow!("bundle read worker missing for path {}", path.display())));
            match read_result.and_then(|src| eval_bundle_src(&js_ctx, &src)) {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("[carbon-mini] bundle load failed: {e:#}");
                    install_hardcoded_scene(&scene);
                }
            }
            timing_log("bundle_evaluated", t0);
        } else {
            install_hardcoded_scene(&scene);
            timing_log("hardcoded_scene_installed", t0);
        }
    }

    // NOTE: the React passive-effect drain that used to run HERE (blocking,
    // ~1 s for terax) is deferred. It now runs in the event loop right AFTER
    // the first paint (see `first_paint_done` in Event::RedrawRequested), so the
    // app's initial tree is on screen before the effects (useEffect / async
    // data / terminal spawn) run and fill content in. The bundle's synchronous
    // `flushSync` render already built a paintable scene above.

    // Plugins register AFTER the bundle has run so their installed globals
    // shadow any user defaults; if a plugin needs to run BEFORE the bundle,
    // it can use the `register` hook to set up state and the `after_reload`
    // hook to (re-)install JS globals each time the bundle re-evals.
    plugin_registry.dispatch_register();
    if plugin_registry.plugin_count() > 0 {
        timing_log("plugins_registered", t0);
    }

    // --dev: spawn a background thread that polls the bundle file's mtime
    // and posts UserEvent::ReloadBundle when it changes. We use polling
    // (vs notify) because:
    //   - 100 ms latency is fine for HMR (humans don't notice)
    //   - Zero new transitive deps
    //   - Cross-platform without backend-specific bugs
    //   - Cold-start cost = 0 (thread isn't spawned in non-dev mode)
    // The 50 ms post-change settle delay debounces editor save bursts and
    // also gives the build pipeline (CLI's vite/bun rebuild) time to finish
    // writing the new bytecode atomically.
    if dev_mode {
        if let Some(path) = bundle_path.clone() {
            let proxy_dev = proxy.clone();
            let watch_path_log = path.clone();
            std::thread::spawn(move || {
                // Per-iteration debounce: after detecting a change, wait
                // until the file's mtime+size have stabilized for STABLE_MS
                // before firing. The CLI build pipeline writes the bundle
                // in two steps (bun build → bytecode compile) and Windows
                // sometimes reports multiple mtime ticks during a single
                // logical write. STABLE_MS=80 ms eliminates the bursts while
                // keeping save→reload feel snappy (~180 ms watcher latency).
                const POLL_MS: u64 = 100;
                const STABLE_MS: u64 = 80;
                let initial_meta = std::fs::metadata(&path);
                let mut last_mtime = initial_meta
                    .as_ref()
                    .ok()
                    .and_then(|m| m.modified().ok());
                let mut last_size: u64 = initial_meta.map(|m| m.len()).unwrap_or(0);
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
                    let meta = match std::fs::metadata(&path) {
                        Ok(m) => m,
                        Err(_) => continue, // file may be momentarily missing during atomic rename
                    };
                    let cur_mtime = meta.modified().ok();
                    let cur_size = meta.len();
                    if cur_mtime == last_mtime && cur_size == last_size {
                        continue;
                    }
                    // Change detected. Loop until the file stops changing
                    // for STABLE_MS, then fire exactly one ReloadBundle.
                    let mut prev_mtime = cur_mtime;
                    let mut prev_size = cur_size;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(STABLE_MS));
                        let m2 = match std::fs::metadata(&path) {
                            Ok(m) => m,
                            Err(_) => break,
                        };
                        let m2_mtime = m2.modified().ok();
                        let m2_size = m2.len();
                        if m2_mtime == prev_mtime && m2_size == prev_size {
                            // Stable for STABLE_MS — fire.
                            last_mtime = m2_mtime;
                            last_size = m2_size;
                            let _ = proxy_dev.send_event(UserEvent::ReloadBundle);
                            break;
                        }
                        prev_mtime = m2_mtime;
                        prev_size = m2_size;
                    }
                }
            });
            eprintln!("[carbon-mini] --dev: watching {} for changes", watch_path_log.display());
        }
    }

    // First-paint sequence with two key optimizations on Win32:
    //
    //   1. Skip the pre-show paint. The buffer.present() call below would only
    //      go to a hidden softbuffer surface that the compositor discards on
    //      first show. The redraw handler in the event loop re-paints once the
    //      compositor surface is ready, so the pre-show work is pure waste.
    //
    //   2. Use ShowWindowAsync instead of ShowWindow — the latter blocks the
    //      calling thread for ~80-115ms waiting on the compositor's
    //      surface allocation; the async variant just posts WM_SHOWWINDOW and
    //      returns immediately. We follow it with InvalidateRect so the OS
    //      schedules a WM_PAINT that lands as Event::RedrawRequested.
    {
        timing_log("first_paint_before_show", t0);
        #[cfg(windows)]
        {
            use tao::platform::windows::WindowExtWindows;
            let hwnd = window.hwnd() as isize;
            extern "system" {
                fn ShowWindowAsync(hwnd: isize, ncmdshow: i32) -> i32;
                fn InvalidateRect(hwnd: isize, rect: *const std::ffi::c_void, erase: i32) -> i32;
            }
            // SW_SHOW = 5
            unsafe {
                ShowWindowAsync(hwnd, 5);
                InvalidateRect(hwnd, std::ptr::null(), 0);
            }
        }
        #[cfg(not(windows))]
        {
            // On non-Windows platforms we keep the original sync paint-then-show
            // dance: the OS compositor on macOS/X11/Wayland may or may not
            // discard the pre-show buffer the same way Win32 does, and the
            // ShowWindowAsync trick is Win32-specific.
            let size = window.inner_size();
            let (w, h) = (size.width.max(1), size.height.max(1));
            if let (Some(nw), Some(nh)) = (NonZeroU32::new(w), NonZeroU32::new(h)) {
                if surface.resize(nw, nh).is_ok() {
                    if let Ok(mut buffer) = surface.buffer_mut() {
                        let mut scene_g = scene.lock().unwrap_or_else(|e| e.into_inner());
                        scene_g.compute_layout(w as f32, h as f32, &mut text_engine.borrow_mut());
                        if let Some(mut canvas) = paint::Canvas::new(w, h) {
                            canvas.clear_white();
                            paint::paint(
                                &scene_g,
                                &mut canvas.pixmap,
                                &mut buffer,
                                w,
                                h,
                                1.0,
                                &mut text_engine.borrow_mut(),
                            );
                            let _ = buffer.present();
                        }
                    }
                }
            }
            window.set_visible(true);
        }
        timing_log("window_show_scheduled", t0);
    }

    // Spawn background updater stop-list poller (if updater enabled).
    // Polls manifest server every 24h (or sooner if [updater] config specifies different interval).
    // Non-blocking: runs on a dedicated thread, doesn't block the event loop.
    #[cfg(feature = "updater")]
    {
        std::thread::spawn(|| {
            let check_interval = std::env::var("CARBON_UPDATE_CHECK_INTERVAL")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(86400); // Default 24h in seconds

            loop {
                std::thread::sleep(std::time::Duration::from_secs(check_interval));

                // Check if updates are available via stop-list polling.
                // In production, this would:
                //   1. Fetch UpdaterManifest from configured URL
                //   2. Verify ed25519 signature with pubkey from carbon.toml [updater]
                //   3. Check if current version is yanked (stop-list)
                //   4. If yanked and auto-rollback enabled, notify app to auto-update
                //   5. If new version available and rollout % allows, notify app
                //
                // For now, this is a placeholder that logs to stderr.
                if let Ok(manifest_url) = std::env::var("CARBON_MANIFEST_URL") {
                    eprintln!("[updater-background] Checking updates from {manifest_url}");
                    // TODO: call carbon_updater::fetch_stop_list() and verify signature
                }
            }
        });
    }

    let mut mouse_pos = (0.0_f32, 0.0_f32);
    let mut modifiers_state = ModifiersState::empty();
    // System clipboard handle. None on platforms where arboard fails to
    // connect (e.g. some headless environments) — Ctrl+C/V/X then no-op.
    let mut clipboard: Option<arboard::Clipboard> = arboard::Clipboard::new().ok();
    // Tracks the input being drag-selected. Set on MouseInput::Pressed
    // when the click lands on an input, cleared on Released. While Some,
    // CursorMoved updates the caret with `extend=true` so the selection
    // grows from the original anchor to the dragged-to position.
    let mut dragging_input: Option<u32> = None;
    // Node that received the most recent pointer-down. Used to route
    // pointer-move/up events back to the same target while the button is
    // held — matches DOM "implicit pointer capture" semantics. Separate
    // from `dragging_input` because that one is textarea-selection
    // specific; this one fires for any node with onMouseDown/Move/Up.
    let mut pointer_down: Option<u32> = None;
    // Multi-click tracking. A press counts as a continuation of the previous
    // click streak when (a) it lands on the same node within ~500 ms, and
    // (b) the cursor hasn't moved more than ~5 px from the previous press.
    // 1 = caret, 2 = select word, 3 = select all (≥3 wraps back to 1).
    let mut last_click: Option<(Instant, (f32, f32), u32)> = None;
    let mut click_streak: u32 = 0;
    // Cloned into the event-loop closure so ReloadBundle can call
    // load_and_eval_bundle without re-entering the borrow checker.
    let reload_path = bundle_path.clone();
    let reload_scene = scene.clone();

    // Move the host_app + registry into the event loop closure. They live
    // for the runtime's full lifetime; only the shutdown handler drops them.
    let mut host_app = host_app;
    let mut plugin_registry = plugin_registry;
    // Caller-owned pixmap: lifted out of `paint::paint` so the main loop
    // can hand the same RGBA8 buffer to plugin `before_paint` hooks (canvas
    // plugins blit GPU readbacks here) before the rasterizer paints UI on
    // top. Reused across frames; only re-allocates on resize.
    let mut paint_canvas: Option<paint::Canvas> = None;
    // Paint-at-first-commit: the very first RedrawRequested paints the initial
    // (synchronously-rendered) tree WITHOUT first running the effect drain, so
    // the app is on screen ASAP. The deferred drain (useEffect / async data)
    // runs right after that first present and fills content in. Flips true once.
    let mut first_paint_done = false;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        // Crash resilience: handle each event inside catch_unwind so a panic
        // in one event's handling (a bad unwrap, an OOB index, a poisoned
        // lock, a native host-import failure) is caught and logged instead of
        // killing the whole window. The app keeps running; the panic hook
        // (install_panic_hook) already recorded the message to LAST_PANIC +
        // stderr. `AssertUnwindSafe` is required because the closure mutably
        // borrows the captured event-loop state — that's fine here: on a
        // caught panic we simply skip the rest of this event and move on, and
        // the next event re-reads state fresh. Poisoned locks are recovered
        // via `.lock().unwrap_or_else(|e| e.into_inner())` throughout.
        let __panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // Run plugin shutdown hooks BEFORE we exit. Bypassed if the
                // OS hard-kills the process, but normal close goes through
                // here so plugins can flush state cleanly.
                plugin_registry.dispatch_on_shutdown();
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                let w = size.width.max(1);
                let h = size.height.max(1);
                host_app.set_window_size(w, h);
                // HOST_WINDOW_SIZE is the LOGICAL (CSS-px) viewport used by
                // off-thread compute_layout; divide physical by scale. The
                // paint loop reads scale_factor() itself and scales up.
                let sf = (window.scale_factor() as f32).max(0.1);
                if let Ok(mut g) = HOST_WINDOW_SIZE.lock() {
                    *g = (w as f32 / sf, h as f32 / sf);
                }
                // Carbon-native window state mirror — JS callers query
                // __cm_window_is_maximized() / .is_minimized() and
                // expect post-resize truth here.
                crate::native::window::set_is_maximized(window.is_maximized());
                crate::native::window::set_is_minimized(window.is_minimized());
                crate::native::window::set_inner_size(w, h);
                crate::native::window::set_scale_factor(window.scale_factor());
                crate::native::window::bump_resize_tick();
                // Fire any registered JS resize listeners. The dispatcher
                // is installed by the @/native/window TS wrapper.
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(
                    b"globalThis.__cm_window_dispatch_resize && globalThis.__cm_window_dispatch_resize();" as &[u8],
                ));
                plugin_registry.dispatch_on_resize(w, h);
                // Mark scene dirty so the paint loop actually recomputes
                // layout for the new dimensions (otherwise the redraw
                // request is short-circuited by the dirty-flag check).
                {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.dirty = true;
                }
                window.request_redraw();
            }
            Event::WindowEvent {
                event: WindowEvent::Focused(focused),
                ..
            } => {
                crate::native::window::set_is_focused(focused);
            }
            Event::WindowEvent {
                event: WindowEvent::CursorMoved { position, .. },
                ..
            } => {
                // DPI-aware: pointer positions arrive in PHYSICAL px but the
                // scene/layout is in LOGICAL px, so convert here — every
                // hit_test downstream then matches the boxes it tests.
                let sf = (window.scale_factor() as f32).max(0.1);
                mouse_pos = (position.x as f32 / sf, position.y as f32 / sf);
                if std::env::var_os("CARBON_MINI_CLICK_DEBUG").is_some() {
                    eprintln!("[carbon-mini-move] ({:.1}, {:.1})", mouse_pos.0, mouse_pos.1);
                }
                // While any pointer-down is in flight, route pointer-move
                // events back to the original target (implicit capture).
                // Fires alongside the input-drag selection logic below
                // because they target different listeners.
                if let Some(pd_id) = pointer_down {
                    let script = format!(
                        "globalThis.__cm_dispatch_pointer && globalThis.__cm_dispatch_pointer({}, \"move\", {}, {}, 0);",
                        pd_id, mouse_pos.0, mouse_pos.1
                    );
                    let _ = js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch pointer move: {e}"))?;
                        Ok(())
                    });
                }
                // While the mouse button is held inside an input we
                // extend the selection to the dragged-to character.
                if let Some(drag_id) = dragging_input {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let abs_x = absolute_x(&s, drag_id);
                    let abs_y = absolute_y(&s, drag_id);
                    let local_x = mouse_pos.0 - abs_x;
                    let local_y = mouse_pos.1 - abs_y;
                    let off = s.input_caret_from_xy(
                        drag_id,
                        local_x,
                        local_y,
                        &mut text_engine.borrow_mut(),
                    );
                    s.input_set_caret(drag_id, off, true);
                    s.dirty = true;
                    window.request_redraw();
                }
                // Hover tracking: hit-test the cursor against clickable
                // nodes; if the hovered node changed, mark the scene
                // dirty so paint can swap in *_hover props. Also pick
                // the right OS cursor — pointer over clickable, default
                // elsewhere — so the UI matches what users expect from
                // a real desktop app.
                {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let hit = s.hit_test(mouse_pos.0, mouse_pos.1);
                    if hit != s.hovered {
                        let prev = s.hovered;
                        s.hovered = hit;
                        if std::env::var_os("CARBON_MINI_HOVER_DEBUG").is_some() {
                            let bg_hov = hit.and_then(|i| s.nodes.get(&i)).and_then(|n| n.props.background_hover);
                            let col_hov = hit.and_then(|i| s.nodes.get(&i)).and_then(|n| n.props.color_hover);
                            eprintln!(
                                "[carbon-mini-hover] prev={:?} -> hit={:?} bg_hover={:?} color_hover={:?}",
                                prev, hit, bg_hov.map(|c| format!("#{:08x}", c)), col_hov.map(|c| format!("#{:08x}", c))
                            );
                        }
                        // Hover only flips paint-only props (backgroundHover,
                        // colorHover) — it never changes any node's box. So
                        // it's a `repaint_dirty` event, not a full structural
                        // dirty. Damage rect = bounding box of (old hovered,
                        // new hovered) so we only repaint those two regions.
                        if let Some(id) = prev {
                            if let Some(b) = s.absolute_box(id) {
                                s.add_damage(b.0, b.1, b.2, b.3);
                            }
                        }
                        if let Some(id) = hit {
                            if let Some(b) = s.absolute_box(id) {
                                s.add_damage(b.0, b.1, b.2, b.3);
                            }
                        }
                        s.repaint_dirty = true;
                        window.request_redraw();
                        // Translate the hovered node's `cursor` prop into a
                        // tao CursorIcon. Default: clickable → pointer,
                        // anything else → default arrow.
                        let icon = match hit {
                            Some(id) => match s.nodes.get(&id) {
                                Some(n) => match n.props.cursor.as_deref() {
                                    Some("default") | Some("auto") | Some("inherit") => {
                                        tao::window::CursorIcon::Default
                                    }
                                    Some("pointer") | Some("hand") => {
                                        tao::window::CursorIcon::Hand
                                    }
                                    Some("text") | Some("ibeam") => {
                                        tao::window::CursorIcon::Text
                                    }
                                    Some("crosshair") => tao::window::CursorIcon::Crosshair,
                                    Some("not-allowed") | Some("notallowed") => {
                                        tao::window::CursorIcon::NotAllowed
                                    }
                                    Some("wait") | Some("progress") => {
                                        tao::window::CursorIcon::Progress
                                    }
                                    Some("grab") => tao::window::CursorIcon::Grab,
                                    Some("grabbing") => tao::window::CursorIcon::Grabbing,
                                    Some("col-resize") | Some("colresize") => {
                                        tao::window::CursorIcon::ColResize
                                    }
                                    Some("row-resize") | Some("rowresize") => {
                                        tao::window::CursorIcon::RowResize
                                    }
                                    // No explicit cursor — clickable nodes
                                    // get the pointer hand by default.
                                    _ if n.props.clickable => {
                                        tao::window::CursorIcon::Hand
                                    }
                                    _ => tao::window::CursorIcon::Default,
                                },
                                None => tao::window::CursorIcon::Default,
                            },
                            None => tao::window::CursorIcon::Default,
                        };
                        window.set_cursor_icon(icon);
                    }
                }
            }
            Event::WindowEvent {
                event:
                    WindowEvent::MouseInput {
                        state: ElementState::Pressed,
                        button: MouseButton::Left,
                        ..
                    },
                ..
            } => {
                let (hit, drag_region) = {
                    let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    (
                        s.hit_test(mouse_pos.0, mouse_pos.1),
                        s.hit_test_drag_region(mouse_pos.0, mouse_pos.1),
                    )
                };
                if std::env::var_os("CARBON_MINI_CLICK_DEBUG").is_some() {
                    eprintln!(
                        "[carbon-mini-click] mouse=({:.1}, {:.1}) hit={:?} drag_region={:?}",
                        mouse_pos.0, mouse_pos.1, hit, drag_region
                    );
                    // ALWAYS dump the node-stack under the cursor (not just on misses)
                    // so we can correlate "hit=Some(X)" with which clickables existed at
                    // that point. Helps catch buttons-without-onClick bugs.
                    {
                        let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        let (mx, my) = mouse_pos;
                        let mut hits: Vec<(u32, String, f32, f32, f32, f32, bool, bool)> = Vec::new();
                        fn collect(
                            s: &crate::scene::Scene,
                            id: u32,
                            ox: f32, oy: f32,
                            mx: f32, my: f32,
                            out: &mut Vec<(u32, String, f32, f32, f32, f32, bool, bool)>,
                        ) {
                            let Some(n) = s.nodes.get(&id) else { return; };
                            let Some(layout) = n.computed_layout else { return; };
                            let nx = ox + layout.location.x;
                            let ny = oy + layout.location.y;
                            let nw = layout.size.width;
                            let nh = layout.size.height;
                            if mx >= nx && my >= ny && mx <= nx + nw && my <= ny + nh {
                                out.push((id, n.tag.clone(), nx, ny, nw, nh, n.props.clickable, n.props.drag_region));
                                for &c in &n.children {
                                    collect(s, c, nx, ny, mx, my, out);
                                }
                            }
                        }
                        collect(&s, s.root, 0.0, 0.0, mx, my, &mut hits);
                        eprintln!("[carbon-mini-click]   stack ({:.0},{:.0}):", mx, my);
                        for (id, tag, nx, ny, nw, nh, cl, dr) in hits.iter().rev().take(8) {
                            eprintln!("    id={} tag={} box=({:.0},{:.0}) {:.0}x{:.0} clickable={} drag={}", id, tag, nx, ny, nw, nh, cl, dr);
                        }
                    }
                    if false {
                        let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        let (mx, my) = mouse_pos;
                        let mut hits: Vec<(u32, &str, f32, f32, f32, f32, bool, bool)> = Vec::new();
                        fn collect<'a>(
                            s: &'a crate::scene::Scene,
                            id: u32,
                            ox: f32, oy: f32,
                            mx: f32, my: f32,
                            out: &mut Vec<(u32, &'a str, f32, f32, f32, f32, bool, bool)>,
                        ) {
                            let Some(n) = s.nodes.get(&id) else { return; };
                            let Some(layout) = n.computed_layout else { return; };
                            let nx = ox + layout.location.x;
                            let ny = oy + layout.location.y;
                            let nw = layout.size.width;
                            let nh = layout.size.height;
                            if mx >= nx && my >= ny && mx <= nx + nw && my <= ny + nh {
                                out.push((id, n.tag.as_str(), nx, ny, nw, nh, n.props.clickable, n.props.drag_region));
                                for &c in &n.children {
                                    collect(s, c, nx, ny, mx, my, out);
                                }
                            }
                        }
                        collect(&s, s.root, 0.0, 0.0, mx, my, &mut hits);
                        eprintln!("[carbon-mini-click]   nodes containing point ({:.0},{:.0}):", mx, my);
                        for (id, tag, nx, ny, nw, nh, cl, dr) in hits.iter().rev().take(15) {
                            eprintln!("    id={} tag={} box=({:.0},{:.0}) {:.0}x{:.0} clickable={} drag={}", id, tag, nx, ny, nw, nh, cl, dr);
                        }
                    }
                }
                // Drag region wins ONLY when nothing clickable was hit.
                // `hit_test_drag_region` already guards against this, but
                // we double-check to be explicit. Calling drag_window()
                // here starts an OS-level move loop; this thread returns
                // to the event loop immediately while the OS drives the
                // drag until the user releases the mouse.
                if hit.is_none() && drag_region.is_some() {
                    let _ = window.drag_window();
                    // Don't fall through to the click-handler path —
                    // drag-region presses don't fire JS click events.
                    // Return from this closure call; the next OS event
                    // will dispatch a fresh invocation.
                    return;
                }
                if let Some(node_id) = hit {
                    // Update focus + position caret if the clicked node is
                    // an input. We compute box-local x by subtracting the
                    // cumulative parent offset and padding before handing
                    // to the caret hit-test.
                    let (is_input, box_x_local) = {
                        let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        let n = s.nodes.get(&node_id).cloned();
                        match n.as_ref().map(|n| n.kind.clone()) {
                            Some(scene::NodeKind::Input)
                            | Some(scene::NodeKind::Textarea) => {
                                // Walk up the tree to compute the node's
                                // absolute screen x-position from layout
                                // locations.
                                let abs_x = absolute_x(&s, node_id);
                                (true, mouse_pos.0 - abs_x)
                            }
                            _ => (false, 0.0),
                        }
                    };
                    if is_input {
                        // Multi-click: count this press as part of a streak
                        // when it lands on the same input fast enough and
                        // close enough to the previous one.
                        let now = Instant::now();
                        let same_target = last_click
                            .as_ref()
                            .map(|(t, p, n)| {
                                *n == node_id
                                    && now.duration_since(*t).as_millis() < 500
                                    && (mouse_pos.0 - p.0).abs() < 5.0
                                    && (mouse_pos.1 - p.1).abs() < 5.0
                            })
                            .unwrap_or(false);
                        click_streak = if same_target { click_streak + 1 } else { 1 };
                        if click_streak > 3 {
                            click_streak = 1;
                        }
                        last_click = Some((now, mouse_pos, node_id));

                        let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        s.focused = Some(node_id);
                        let extend = modifiers_state.shift_key();
                        // Pass mouse Y too so multi-line textareas know
                        // which line was clicked.
                        let abs_y = absolute_y(&s, node_id);
                        let local_y = mouse_pos.1 - abs_y;
                        let off = s.input_caret_from_xy(
                            node_id,
                            box_x_local,
                            local_y,
                            &mut text_engine.borrow_mut(),
                        );
                        match click_streak {
                            2 => {
                                // Double click: select the word at the
                                // hit-tested offset.
                                s.input_select_word(node_id, off);
                                // Drag from a double-click extends by
                                // word — disable for now and just leave
                                // the word selected.
                                dragging_input = None;
                            }
                            3 => {
                                // Triple click: select everything in this
                                // input. Matches what most OS text inputs
                                // do for `<input>`; for `<textarea>`,
                                // selecting the line is common too, but
                                // "all" is the simplest and most
                                // predictable here.
                                s.input_select_all(node_id);
                                dragging_input = None;
                            }
                            _ => {
                                s.input_set_caret(node_id, off, extend);
                                // Mark this input as "currently being
                                // drag-selected" so subsequent
                                // CursorMoved events extend the
                                // selection until mouse up.
                                dragging_input = Some(node_id);
                            }
                        }
                        s.dirty = true;
                        window.request_redraw();
                    } else {
                        // Clicking outside any input clears focus.
                        let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        if s.focused.is_some() {
                            s.focused = None;
                            s.dirty = true;
                            window.request_redraw();
                        }
                    }
                    let script = format!(
                        "globalThis.__cm_dispatch_click && globalThis.__cm_dispatch_click({});\nglobalThis.__cm_dispatch_pointer && globalThis.__cm_dispatch_pointer({}, \"down\", {}, {}, 0);",
                        node_id, node_id, mouse_pos.0, mouse_pos.1
                    );
                    let _ = js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch click: {e}"))?;
                        Ok(())
                    });
                    // Click handlers commonly setState → schedule a render.
                    // Drain queued microtasks now so the render commits
                    // (and useEffects fire) before next user input.
                    drain_and_flush_react(&js_rt, &js_ctx);
                    pointer_down = Some(node_id);
                } else {
                    // Clicked into empty space — drop focus.
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    if s.focused.is_some() {
                        s.focused = None;
                        s.dirty = true;
                        window.request_redraw();
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::ModifiersChanged(mods),
                ..
            } => {
                modifiers_state = mods;
            }
            Event::WindowEvent {
                event: WindowEvent::ThemeChanged(theme),
                ..
            } => {
                use tao::window::Theme;
                let name = match theme {
                    Theme::Dark => "dark",
                    _ => "light",
                };
                os_theme::set(name);
                let script = format!(
                    "globalThis.__cm_dispatch_theme_changed && globalThis.__cm_dispatch_theme_changed(\"{}\");",
                    name
                );
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::Focused(focused),
                ..
            } => {
                let script = format!(
                    "globalThis.__cm_dispatch_window_focus && globalThis.__cm_dispatch_window_focus({});",
                    focused
                );
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::HoveredFile(path),
                ..
            } => {
                // OS drag-hover: file is being dragged across the window
                // (one event per file). Forwarded as a single 'enter'
                // dispatch — JS-side handlers can aggregate.
                let path_str = path.to_string_lossy().to_string();
                let path_json = serde_json::to_string(&path_str)
                    .unwrap_or_else(|_| "\"\"".into());
                let script = format!(
                    "globalThis.__cm_dispatch_file_drag && globalThis.__cm_dispatch_file_drag('enter', {});",
                    path_json
                );
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::HoveredFileCancelled,
                ..
            } => {
                // Drag exited the window without dropping — fire 'leave'
                // with no path so JS handlers can reset visual state.
                let script = "globalThis.__cm_dispatch_file_drag && globalThis.__cm_dispatch_file_drag('leave', null);";
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::DroppedFile(path),
                ..
            } => {
                // File dropped onto the window. tao fires one event per
                // file — JS sees one 'drop' dispatch per file. Apps that
                // want a "drop session complete" signal can debounce in
                // JS (the events arrive in the same event-loop tick).
                let path_str = path.to_string_lossy().to_string();
                let path_json = serde_json::to_string(&path_str)
                    .unwrap_or_else(|_| "\"\"".into());
                let script = format!(
                    "globalThis.__cm_dispatch_file_drag && globalThis.__cm_dispatch_file_drag('drop', {});",
                    path_json
                );
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event:
                    WindowEvent::MouseInput {
                        state: ElementState::Pressed,
                        button: MouseButton::Right,
                        ..
                    },
                ..
            } => {
                // Right-click → hit-test → dispatch context-menu event
                // to JS at the cursor position. App handlers can show a
                // floating menu via createPortal + absolute positioning.
                let hit = {
                    let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.hit_test(mouse_pos.0, mouse_pos.1)
                };
                let hit_arg = match hit {
                    Some(id) => id.to_string(),
                    None => "null".to_string(),
                };
                let script = format!(
                    "globalThis.__cm_dispatch_context_menu && globalThis.__cm_dispatch_context_menu({}, {}, {});",
                    hit_arg, mouse_pos.0, mouse_pos.1
                );
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event:
                    WindowEvent::MouseInput {
                        state: ElementState::Released,
                        button: MouseButton::Left,
                        ..
                    },
                ..
            } => {
                // Drag-select complete — anchor stays where it was,
                // caret stays at last hit-test position.
                dragging_input = None;
                if let Some(pd_id) = pointer_down.take() {
                    let script = format!(
                        "globalThis.__cm_dispatch_pointer && globalThis.__cm_dispatch_pointer({}, \"up\", {}, {}, 0);",
                        pd_id, mouse_pos.0, mouse_pos.1
                    );
                    let _ = js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch pointer up: {e}"))?;
                        Ok(())
                    });
                }
            }
            Event::WindowEvent {
                event: WindowEvent::KeyboardInput { event: key_event, .. },
                ..
            } => {
                if key_event.state != ElementState::Pressed {
                    return;
                }
                // App-level keyboard dispatch: forward the event to a
                // JS listener so apps can implement shortcuts without
                // hijacking the focused-input dispatch below. Listeners
                // see every keydown; modifier-key state is encoded in
                // the args. The dispatcher is a no-op if no app code
                // registered a handler.
                {
                    let key_label = match &key_event.logical_key {
                        Key::Character(s) => s.to_string(),
                        Key::Enter => "Enter".to_string(),
                        Key::Escape => "Escape".to_string(),
                        Key::Tab => "Tab".to_string(),
                        Key::Backspace => "Backspace".to_string(),
                        Key::Delete => "Delete".to_string(),
                        Key::ArrowUp => "ArrowUp".to_string(),
                        Key::ArrowDown => "ArrowDown".to_string(),
                        Key::ArrowLeft => "ArrowLeft".to_string(),
                        Key::ArrowRight => "ArrowRight".to_string(),
                        Key::Space => " ".to_string(),
                        Key::Home => "Home".to_string(),
                        Key::End => "End".to_string(),
                        Key::PageUp => "PageUp".to_string(),
                        Key::PageDown => "PageDown".to_string(),
                        Key::F1 => "F1".to_string(),
                        Key::F2 => "F2".to_string(),
                        Key::F3 => "F3".to_string(),
                        Key::F4 => "F4".to_string(),
                        Key::F5 => "F5".to_string(),
                        Key::F6 => "F6".to_string(),
                        Key::F7 => "F7".to_string(),
                        Key::F8 => "F8".to_string(),
                        Key::F9 => "F9".to_string(),
                        Key::F10 => "F10".to_string(),
                        Key::F11 => "F11".to_string(),
                        Key::F12 => "F12".to_string(),
                        other => format!("{:?}", other),
                    };
                    if std::env::var_os("CARBON_PERF").is_some() {
                        eprintln!("[perf] keydown key={:?} ctrl={}", key_label, modifiers_state.control_key());
                    }
                    let key_json = serde_json::to_string(&key_label)
                        .unwrap_or_else(|_| "\"\"".into());
                    let script = format!(
                        "globalThis.__cm_dispatch_keydown && globalThis.__cm_dispatch_keydown({},{},{},{},{});",
                        key_json,
                        modifiers_state.control_key(),
                        modifiers_state.shift_key(),
                        modifiers_state.alt_key(),
                        modifiers_state.super_key(),
                    );
                    let _ = js_ctx.with(|ctx| -> Result<()> {
                        let _ = ctx.eval::<(), _>(script.as_bytes());
                        Ok(())
                    });
                }
                // Global keybinds — checked BEFORE the focused-input
                // dispatch so they trigger no matter what's focused.
                if modifiers_state.control_key() {
                    let is_space = matches!(&key_event.logical_key, Key::Space)
                        || matches!(
                            &key_event.logical_key,
                            Key::Character(s) if &**s == " "
                        );
                    if is_space {
                        let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        s.debug_layout = !s.debug_layout;
                        s.dirty = true;
                        eprintln!(
                            "[carbon-mini] layout debug overlay: {}",
                            if s.debug_layout { "ON" } else { "OFF" }
                        );
                        window.request_redraw();
                        return;
                    }
                }
                let focused = scene.lock().unwrap_or_else(|e| e.into_inner()).focused;
                let fid = match focused {
                    Some(f) => f,
                    None => return,
                };
                let kind = scene
                    .lock()
                    .unwrap()
                    .nodes
                    .get(&fid)
                    .map(|n| n.kind.clone());
                if !matches!(
                    kind,
                    Some(scene::NodeKind::Input) | Some(scene::NodeKind::Textarea)
                ) {
                    return;
                }
                let is_textarea = matches!(kind, Some(scene::NodeKind::Textarea));
                let ctrl = modifiers_state.control_key();
                let shift = modifiers_state.shift_key();
                let mut value_changed: Option<String> = None;
                let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());

                match &key_event.logical_key {
                    Key::Backspace => {
                        value_changed = s.input_backspace(fid);
                    }
                    Key::Delete => {
                        value_changed = s.input_delete(fid);
                    }
                    Key::ArrowLeft => {
                        s.input_move_caret(fid, scene::CaretMove::Left, shift);
                    }
                    Key::ArrowRight => {
                        s.input_move_caret(fid, scene::CaretMove::Right, shift);
                    }
                    Key::ArrowUp => {
                        if is_textarea {
                            let mw = s.editor_inner_width(fid);
                            s.input_move_caret_vertical(
                                fid,
                                true,
                                shift,
                                mw,
                                &mut text_engine.borrow_mut(),
                            );
                        }
                    }
                    Key::ArrowDown => {
                        if is_textarea {
                            let mw = s.editor_inner_width(fid);
                            s.input_move_caret_vertical(
                                fid,
                                false,
                                shift,
                                mw,
                                &mut text_engine.borrow_mut(),
                            );
                        }
                    }
                    Key::Home => {
                        s.input_move_caret(fid, scene::CaretMove::Home, shift);
                    }
                    Key::End => {
                        s.input_move_caret(fid, scene::CaretMove::End, shift);
                    }
                    Key::Enter if is_textarea => {
                        value_changed = s.input_insert_str(fid, "\n");
                    }
                    Key::Tab => {
                        // Tab / Shift+Tab traverses focus between Input /
                        // Textarea nodes in DOM order — same as a browser.
                        // Wraps at both ends. Caret jumps to start of the
                        // newly-focused input; selection cleared.
                        let focusables = s.focusable_inputs();
                        if !focusables.is_empty() {
                            let cur_idx =
                                focusables.iter().position(|id| *id == fid).unwrap_or(0);
                            let next_idx = if shift {
                                if cur_idx == 0 { focusables.len() - 1 } else { cur_idx - 1 }
                            } else {
                                (cur_idx + 1) % focusables.len()
                            };
                            let next_id = focusables[next_idx];
                            s.focused = Some(next_id);
                            // Caret to start, anchor too (no selection).
                            s.input_set_caret(next_id, 0, false);
                            s.dirty = true;
                        }
                    }
                    Key::Character(ch) if ctrl => {
                        // Ctrl+letter — clipboard / select-all / undo /
                        // redo shortcuts.
                        let ch_lower = ch.to_ascii_lowercase();
                        match ch_lower.as_str() {
                            "z" => {
                                value_changed = if shift {
                                    s.input_redo(fid)
                                } else {
                                    s.input_undo(fid)
                                };
                            }
                            "y" => {
                                value_changed = s.input_redo(fid);
                            }
                            "a" => s.input_select_all(fid),
                            "c" => {
                                if let Some(cb) = clipboard.as_mut() {
                                    let sel = s.input_selected_text(fid);
                                    if !sel.is_empty() {
                                        let _ = cb.set_text(sel);
                                    }
                                }
                            }
                            "x" => {
                                if let Some(cb) = clipboard.as_mut() {
                                    let sel = s.input_selected_text(fid);
                                    if !sel.is_empty() {
                                        let _ = cb.set_text(sel);
                                        value_changed = s.input_backspace(fid);
                                    }
                                }
                            }
                            "v" => {
                                if let Some(cb) = clipboard.as_mut() {
                                    if let Ok(t) = cb.get_text() {
                                        // Single-line input: strip newlines.
                                        let to_paste: String = if is_textarea {
                                            t
                                        } else {
                                            t.replace(['\n', '\r'], " ")
                                        };
                                        value_changed =
                                            s.input_insert_str(fid, &to_paste);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Key::Character(ch) if !ctrl => {
                        // Plain typed character (already accounts for Shift
                        // via the OS keyboard layout — `ch` is already "A"
                        // when shift is held).
                        value_changed = s.input_insert_str(fid, ch);
                    }
                    _ => {
                        // Fall back to KeyEvent.text — covers OEM keys,
                        // dead-key composition output, etc.
                        if !ctrl {
                            if let Some(t) = &key_event.text {
                                if !t.is_empty()
                                    && !t.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
                                {
                                    value_changed = s.input_insert_str(fid, t);
                                }
                            }
                        }
                    }
                }
                drop(s);

                // Notify React/Solid via __cm_dispatch_input(id, value).
                if let Some(v) = value_changed {
                    let escaped = js_string_literal(&v);
                    let script = format!(
                        "globalThis.__cm_dispatch_input && globalThis.__cm_dispatch_input({},{});",
                        fid, escaped
                    );
                    let _ = js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch input: {e}"))?;
                        Ok(())
                    });
                    drain_js_jobs(&js_rt);
                }
                window.request_redraw();
            }
            Event::WindowEvent {
                event: WindowEvent::MouseWheel { delta, .. },
                ..
            } => {
                // Pixel delta works for trackpads; LineDelta needs
                // multiplying by a per-line height. We use 32 logical
                // pixels per line as a sensible UI default (matches the
                // tiny-skia text line-heights we emit).
                // PixelDelta is PHYSICAL px on a DPI-aware window; scroll math
                // and the DOM wheel event work in LOGICAL px, so scale down.
                let sf = (window.scale_factor() as f32).max(0.1);
                let (dx, dy) = match delta {
                    tao::event::MouseScrollDelta::PixelDelta(p) => (p.x as f32 / sf, p.y as f32 / sf),
                    tao::event::MouseScrollDelta::LineDelta(cols, lines) => (cols * 32.0, lines * 32.0),
                    _ => (0.0, 0.0),
                };
                // For the DOM `wheel` event we keep the OS-native delta kind:
                // mouse wheels report whole lines (deltaMode=1, ~3 rows/notch
                // is the conventional terminal feel), trackpads report pixels
                // (deltaMode=0). xterm's wheel normalizer divides pixel deltas
                // heavily, so sending line deltas as pixels scrolls <1 row.
                let (wheel_dx, wheel_dy, wheel_mode): (f32, f32, i32) = match delta {
                    tao::event::MouseScrollDelta::PixelDelta(p) => (-(p.x as f32) / sf, -(p.y as f32) / sf, 0),
                    tao::event::MouseScrollDelta::LineDelta(cols, lines) => {
                        (-cols * 3.0, -lines * 3.0, 1)
                    }
                    _ => (0.0, 0.0, 0),
                };
                if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                    eprintln!(
                        "[carbon-mini-wheel] delta={:?} dx={:.1} dy={:.1} mouse=({:.1},{:.1})",
                        delta, dx, dy, mouse_pos.0, mouse_pos.1
                    );
                }
                if dy.abs() > 0.0 || dx.abs() > 0.0 {
                    // First give JS a real DOM `wheel` event at the element
                    // under the cursor. Anything that scrolls its own content
                    // (xterm's buffer, a custom virtual list) consumes it via
                    // preventDefault — in that case we must NOT also move a
                    // carbon scrollport, or the two fight (the symptom: the
                    // terminal "scrolls" but never reaches its real top/bottom
                    // because the canvas is being slid instead of its rows
                    // re-rendered). DOM delta sign is the negative of tao's.
                    let hit = scene.lock().unwrap_or_else(|e| e.into_inner()).hit_test(mouse_pos.0, mouse_pos.1);
                    let mut handled = false;
                    if let Some(node_id) = hit {
                        let script = format!(
                            "(globalThis.__cm_dispatch_wheel && globalThis.__cm_dispatch_wheel({},{},{},{},{},{}))||false",
                            node_id, wheel_dx, wheel_dy, wheel_mode, mouse_pos.0, mouse_pos.1
                        );
                        handled = js_ctx
                            .with(|ctx| ctx.eval::<bool, _>(script.as_bytes()).unwrap_or(false));
                    }
                    if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                        eprintln!("[carbon-mini-wheel] hit={:?} js_handled={}", hit, handled);
                    }
                    if handled {
                        // xterm re-renders the scrolled rows on a rAF tick;
                        // the redraw handler drains the rAF queue before
                        // painting, so a redraw request is all we need.
                        window.request_redraw();
                    } else {
                        // Native scrollport fallback (file tree, chat, etc.).
                        let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                        let target = s.hit_test_scrollable(mouse_pos.0, mouse_pos.1);
                        if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                            eprintln!("[carbon-mini-wheel] scrollport target={:?}", target);
                        }
                        if let Some(node_id) = target {
                            let cur = s.scroll_y(node_id);
                            // Wheel-down (toward user, dy<0) increases scroll_y
                            // so content moves up; wheel-up decreases it.
                            let new_y = s.set_scroll_y(node_id, cur - dy);
                            if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                                eprintln!(
                                    "[carbon-mini-wheel] node={} {:.1} -> {:.1}",
                                    node_id, cur, new_y
                                );
                            }
                            window.request_redraw();
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::RequestPaint) => {
                window.request_redraw();
            }
            Event::UserEvent(UserEvent::FetchHeaders { id, status, headers_json }) => {
                // headers_json is already a valid JSON array literal, so
                // it's a legal JS expression — splice it directly into
                // the dispatch call instead of double-stringifying.
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_headers && globalThis.__cm_fetch_dispatch_headers({},{},{});",
                    id, status, headers_json,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::FetchChunk { id, data }) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_chunk && globalThis.__cm_fetch_dispatch_chunk({},\"{}\");",
                    id, b64,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::FetchEnd { id }) => {
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_end && globalThis.__cm_fetch_dispatch_end({});",
                    id,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::FetchError { id, message }) => {
                let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_error && globalThis.__cm_fetch_dispatch_error({},{});",
                    id, msg,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::ChannelMessage { channel_id, json }) => {
                // `json` is already a valid JSON object literal (built via
                // serde_json::json! on the sending side), so splice it
                // directly rather than re-stringifying it into a JS string.
                let script = format!(
                    "globalThis.__cm_channel_dispatch && globalThis.__cm_channel_dispatch({},{});",
                    channel_id, json,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsOpen { id }) => {
                let script = format!(
                    "globalThis.__cm_ws_dispatch_open && globalThis.__cm_ws_dispatch_open({});",
                    id,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsMessage { id, data, is_text }) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                let script = format!(
                    "globalThis.__cm_ws_dispatch_message && globalThis.__cm_ws_dispatch_message({},\"{}\",{});",
                    id, b64, is_text,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsClose { id, code, reason }) => {
                let reason_json = serde_json::to_string(&reason).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "globalThis.__cm_ws_dispatch_close && globalThis.__cm_ws_dispatch_close({},{},{});",
                    id, code, reason_json,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsError { id, message }) => {
                let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "globalThis.__cm_ws_dispatch_error && globalThis.__cm_ws_dispatch_error({},{});",
                    id, msg,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::PtyOutput { id }) => {
                let script = format!(
                    "globalThis.__cm_pty_dispatch_output && globalThis.__cm_pty_dispatch_output({});",
                    id,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
                drain_and_flush_react(&js_rt, &js_ctx);
                window.request_redraw();
            }
            Event::UserEvent(UserEvent::PtyExit { id }) => {
                let script = format!(
                    "globalThis.__cm_pty_dispatch_exit && globalThis.__cm_pty_dispatch_exit({});",
                    id,
                );
                let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
                drain_and_flush_react(&js_rt, &js_ctx);
                window.request_redraw();
            }
            Event::UserEvent(UserEvent::WindowOp(op)) => {
                use crate::WindowOp::*;
                match op {
                    Show => window.set_visible(true),
                    Hide => window.set_visible(false),
                    Minimize => window.set_minimized(true),
                    Maximize => window.set_maximized(true),
                    Unmaximize => window.set_maximized(false),
                    ToggleMaximize => window.set_maximized(!window.is_maximized()),
                    Restore => {
                        window.set_minimized(false);
                        window.set_visible(true);
                    }
                    Focus => window.set_focus(),
                    Close => *control_flow = ControlFlow::Exit,
                }
            }
            Event::UserEvent(UserEvent::WindowSetTitle(title)) => {
                window.set_title(&title);
            }
            Event::UserEvent(UserEvent::WindowSetFullscreen(on)) => {
                if on {
                    window.set_fullscreen(Some(tao::window::Fullscreen::Borderless(None)));
                } else {
                    window.set_fullscreen(None);
                }
            }
            Event::UserEvent(UserEvent::WindowStartDrag) => {
                // Begins an OS-level move loop. Returns immediately;
                // movement is driven by the OS until the user releases
                // the mouse. Errors silently if the window is in a
                // state that doesn't allow drag (e.g. maximized).
                let _ = window.drag_window();
            }
            Event::UserEvent(UserEvent::PluginEvent { name, payload }) => {
                // Dispatch the event into JS. The dispatcher (installed at
                // startup) routes it to all `globalThis.carbon.on(name, …)`
                // subscribers. We keep this on the JS thread (event loop's
                // closure runs there).
                let escaped_name = json_escape(&name);
                let payload_for_eval = if payload.is_empty() {
                    "null".to_string()
                } else {
                    json_escape(&payload)
                };
                let script = format!(
                    "globalThis.__carbon_on_event && globalThis.__carbon_on_event(\"{escaped_name}\", \"{payload_for_eval}\");"
                );
                let _ = js_ctx.with(|ctx| -> Result<()> {
                    if let Err(e) = ctx.eval::<(), _>(script.as_bytes()) {
                        eprintln!("[carbon-mini-plugin] dispatch `{name}` failed: {e}");
                    }
                    Ok(())
                });
            }
            Event::UserEvent(UserEvent::ReloadBundle) => {
                let t_reload = Instant::now();
                if let Some(path) = &reload_path {
                    // 0. Notify plugins that an HMR reload is about to start
                    //    so they can pause workers and drop JS-owned values.
                    plugin_registry.dispatch_before_reload();

                    // 1. Tell the JS side to harvest signals + drop its
                    //    renderer state. The user's bundle exports a
                    //    __cm_hmr_reset hook on globalThis the first time
                    //    it loads (see carbon/runtime/engine/paint/renderers/solid/src/index.ts);
                    //    this clears rootNode, click handlers, nextId etc.
                    //    so the next mount() builds a fresh tree.
                    let _ = js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(
                            "globalThis.__cm_hmr_reset && globalThis.__cm_hmr_reset();"
                                .as_bytes(),
                        )
                        .ok();
                        Ok(())
                    });

                    // 2. Reset the Rust-side scene graph: drop every node
                    //    and the Taffy tree. The next bundle's mount() call
                    //    will recreate root + children with fresh IDs.
                    {
                        let mut s = reload_scene.lock().unwrap_or_else(|e| e.into_inner());
                        s.reset_for_hmr();
                    }

                    // 3. Re-eval the bundle in the SAME context. The
                    //    __hmr_state Map on globalThis survives because
                    //    we don't drop the runtime — createPersistentSignal
                    //    reads its previous values back during construction.
                    match load_and_eval_bundle(&js_ctx, path) {
                        Ok(()) => {
                            let ms = t_reload.elapsed().as_secs_f64() * 1000.0;
                            eprintln!("[carbon-mini-hmr] reloaded in {ms:.1} ms");
                        }
                        Err(e) => {
                            eprintln!("[carbon-mini-hmr] reload FAILED: {e:#}");
                        }
                    }

                    // 4. Plugins re-install whatever globals the bundle's
                    //    re-eval clobbered. We do NOT call register again;
                    //    plugins manage their own re-init via after_reload.
                    plugin_registry.dispatch_after_reload();

                    // 5. Repaint with the new tree.
                    window.request_redraw();
                }
            }
            Event::RedrawRequested(_) => {
                prof_zone!("frame_redraw_event");

                // Drain any pending requestAnimationFrame callbacks before
                // we paint. They may issue draw commands that change the
                // wgpu surface contents; we want those committed *before*
                // the readback path picks them up below.
                // Also drain JS microtasks so any Promises / passive
                // effects scheduled inside the raf callback run before
                // paint instead of next frame.
                // On the very first paint, SKIP this drain — paint the initial
                // tree first (the deferred effect drain runs after we present,
                // below). Every later frame drains rAF + microtasks before paint.
                let drained = if first_paint_done {
                    let _js_t = Instant::now();
                    drain_js_jobs(&js_rt);
                    let d = js_ctx.with(|ctx| -> bool {
                        let now_ms = (Instant::now().elapsed().as_secs_f64() * 1000.0) as f64;
                        let script = format!(
                            "globalThis.__cm_drain_raf && globalThis.__cm_drain_raf({});",
                            now_ms
                        );
                        let _ = ctx.eval::<(), _>(script.as_bytes());
                        // Whether anything was drained — if so, request another paint
                        // so the rAF loop continues.
                        let q_size: i64 = ctx
                            .eval::<i64, _>(
                                "globalThis.__cm_raf_queue ? globalThis.__cm_raf_queue.size : 0".as_bytes(),
                            )
                            .unwrap_or(0);
                        q_size > 0
                    });
                    // Pump JS microtasks again so passive effects scheduled
                    // inside raf / setTimeout callbacks fire this frame.
                    drain_js_jobs(&js_rt);
                    if std::env::var_os("CARBON_PERF").is_some() {
                        let ms = _js_t.elapsed().as_secs_f64() * 1000.0;
                        if ms > 3.0 {
                            eprintln!("[perf]   js raf+microtasks: {ms:.1}ms (drained={d})");
                        }
                    }
                    d
                } else {
                    false
                };

                // ─── Damage Tracking ───────────────────────────────────────────
                // Two damage flags: `dirty` forces a layout pass + paint;
                // `repaint_dirty` forces only paint (cached layout reused).
                // Scroll, hover, focus blink — anything that changes pixels
                // without changing any node's box — sets `repaint_dirty`.
                // Idle frames where neither is set short-circuit out.
                let (scene_dirty, repaint_dirty) = {
                    let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    (s.dirty, s.repaint_dirty)
                };

                if !scene_dirty && !repaint_dirty && first_paint_done {
                    // Nothing VISUAL changed this frame. Draining rAF is NOT by
                    // itself a reason to repaint: an idle app with a live timer
                    // (xterm cursor blink, a stray setInterval, a settled motion
                    // animation) keeps the rAF queue non-empty every frame, and
                    // the old `!drained` guard meant we ran a full
                    // layout+paint+readback ~80×/sec while completely idle. Scene
                    // mutations performed during the drain set `dirty` /
                    // `repaint_dirty` synchronously (see scene.rs set_prop /
                    // insert_node / set_text), so genuine changes still paint.
                    // Keep the rAF loop ticking (so timers/animations fire next
                    // frame) but skip the paint pass entirely.
                    if drained { window.request_redraw(); }
                    return;
                }

                let size = window.inner_size();
                let (w, h) = (size.width.max(1), size.height.max(1));
                if let (Some(nw), Some(nh)) = (NonZeroU32::new(w), NonZeroU32::new(h)) {
                    if let Err(_e) = surface.resize(nw, nh) {
                        return;
                    }
                    // Lazy-allocate / resize the caller-owned pixmap.
                    let canvas_ok = match &mut paint_canvas {
                        Some(c) => c.ensure_size(w, h),
                        None => {
                            paint_canvas = paint::Canvas::new(w, h);
                            paint_canvas.is_some()
                        }
                    };
                    if !canvas_ok { return; }
                    let canvas = paint_canvas.as_mut().unwrap();
                    if let Ok(mut buffer) = surface.buffer_mut() {
                        // HiDPI: the buffer/pixmap are PHYSICAL px (w,h), but
                        // layout runs in LOGICAL (CSS) px — physical / scale.
                        // paint() then scales geometry (root transform) and
                        // text (TextEngine::scale) up to physical. This keeps
                        // the scene graph + JS geometry in CSS px (matching a
                        // browser) while rendering crisp at native resolution.
                        let scale_f = (window.scale_factor() as f32).max(0.1);
                        {
                            prof_zone!("frame_layout");
                            let mut scene_g = scene.lock().unwrap_or_else(|e| e.into_inner());
                            scene_g.compute_layout(
                                w as f32 / scale_f,
                                h as f32 / scale_f,
                                &mut text_engine.borrow_mut(),
                            );
                        }
                        // Two paint modes:
                        //   * Scoped: !dirty && dirty_rect.is_some()
                        //     Fast path. Skip whole-pixmap clear; instead
                        //     erase ONLY the damage rect (so old text /
                        //     stale pixels inside it are guaranteed gone)
                        //     and let paint_node's cull skip everything
                        //     outside it.
                        //   * Full: dirty=true (or no scoped damage)
                        //     Slow path. clear_white the whole pixmap and
                        //     paint everything. Must NULL the dirty_rect
                        //     before paint, otherwise the paint_node cull
                        //     would treat a stale rect from a prior
                        //     scroll as the current damage and skip nodes
                        //     that need to repaint.
                        let scoped_damage = {
                            let s = scene.lock().unwrap_or_else(|e| e.into_inner());
                            !s.dirty && s.dirty_rect.is_some()
                        };
                        if scoped_damage {
                            // Erase only the damage rect to white. This
                            // hard-resets pixels in the rect before paint
                            // so any text / chip / glyph from the previous
                            // frame is guaranteed gone, killing the
                            // alpha-stacking artifact that "skip clear +
                            // rely on bg fills" left at edges where the
                            // bg fill didn't fully cover.
                            if let Some((dx, dy, dw, dh)) = scene.lock().unwrap_or_else(|e| e.into_inner()).dirty_rect {
                                // dirty_rect is in LOGICAL px (scene coords);
                                // the pixmap is physical, so scale the erase.
                                if let Some(rect) = Rect::from_xywh(dx, dy, dw.max(0.001), dh.max(0.001)) {
                                    let mut p = Paint::default();
                                    p.set_color_rgba8(255, 255, 255, 255);
                                    p.anti_alias = false;
                                    canvas.pixmap.fill_rect(
                                        rect,
                                        &p,
                                        Transform::from_scale(scale_f, scale_f),
                                        None,
                                    );
                                }
                            }
                        } else {
                            canvas.clear_white();
                            // Throw away any stale damage rect so the
                            // paint_node cull doesn't apply during a
                            // full-window paint.
                            scene.lock().unwrap_or_else(|e| e.into_inner()).dirty_rect = None;
                        }
                        // before_paint now hands plugins a real RGBA8 buffer
                        // they can blit into. Canvas plugins read their
                        // wgpu offscreen render target and blit to their
                        // layout box; FPS / telemetry plugins just observe.
                        let stride = canvas.stride_bytes();
                        plugin_registry.dispatch_before_paint(
                            canvas.as_bytes_mut(),
                            w,
                            h,
                            stride,
                        );
                        let _perf_paint = std::time::Instant::now();
                        paint::paint(
                            &scene.lock().unwrap_or_else(|e| e.into_inner()),
                            &mut canvas.pixmap,
                            &mut buffer,
                            w,
                            h,
                            scale_f,
                            &mut text_engine.borrow_mut(),
                        );
                        if std::env::var_os("CARBON_PERF").is_some() {
                            let ms = _perf_paint.elapsed().as_secs_f64() * 1000.0;
                            if ms > 2.0 { eprintln!("[perf] paint: {ms:.1}ms"); }
                        }

                        // Clear all damage flags after successful paint.
                        // Next RedrawRequested will short-circuit unless
                        // something else marks the scene damaged again.
                        {
                            let mut scene_g = scene.lock().unwrap_or_else(|e| e.into_inner());
                            scene_g.dirty = false;
                            scene_g.repaint_dirty = false;
                            scene_g.dirty_rect = None;
                        }

                        // Mark first frame success for updater crash-counter reset.
                        // Only fires once per session — subsequent paints don't re-execute.
                        #[cfg(feature = "updater")]
                        {
                            static FIRST_FRAME_MARKED: std::sync::atomic::AtomicBool =
                                std::sync::atomic::AtomicBool::new(false);
                            if !FIRST_FRAME_MARKED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                                if let Ok(install_dir) = std::env::var("CARBON_INSTALL_DIR") {
                                    let _ = carbon_updater::SlotState::load(std::path::Path::new(&install_dir))
                                        .and_then(|mut state| {
                                            state.mark_first_frame(std::path::Path::new(&install_dir))
                                        })
                                        .map_err(|e| eprintln!("[updater] first-frame mark failed: {e}"));
                                }
                            }
                        }

                        let _ = buffer.present();
                        plugin_registry.dispatch_after_paint();

                        // ─── First paint just hit the screen ───────────────
                        if !first_paint_done {
                            first_paint_done = true;
                            timing_log("first_paint_visible", t0);
                            timing_done("startup → first paint", t0);
                            // Now run the deferred React effect drain (useEffect,
                            // async data loads, terminal spawn, …). The shell is
                            // already visible; this fills in the content and then
                            // we repaint with it.
                            drain_and_flush_react(&js_rt, &js_ctx);
                            timing_log("effects_drained", t0);
                            timing_done("startup → content ready", t0);
                            window.request_redraw();
                        }
                    }
                }

                // Schedule the next frame if rAF callbacks scheduled new ones
                // (which is the typical pattern: a callback re-arms itself).
                if drained {
                    window.request_redraw();
                }
            }
            _ => {}
        }
        })); // end catch_unwind

        if __panic_result.is_err() {
            // A panic was caught and already logged by the hook. Keep the
            // event loop alive (do NOT exit) so a single bad event doesn't
            // take down the whole app — the core "never crash" guarantee.
            // Request a repaint so the UI recovers on the next frame if the
            // panic left it mid-update.
            let detail = LAST_PANIC
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_else(|| "unknown panic".to_string());
            eprintln!("[carbon-mini] recovered from panic during event handling: {detail}");
            window.request_redraw();
        }
    });
}

// The paint dispatch — canvas2d, svg, blur, css_parse, and the tiny-skia
// draw-call walk itself — extracted to its own crate. Aliased so every
// existing `paint::X` call site (set_project_dir, Canvas::new, paint::paint)
// is unchanged.
use carbon_paint as paint;
// main.rs's own event loop also calls `crate::canvas2d::X` directly (the
// <canvas> 2D context host imports), not just through paint's dispatch.
use carbon_paint::canvas2d;

fn install_hardcoded_scene(scene: &Arc<Mutex<Scene>>) {
    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
    s.create_node(
        1,
        "view",
        PaintProps {
            background: Some(0xFFE5_E7EB),
            ..PaintProps::default()
        },
    );
    s.set_root(1);
    s.create_node(
        2,
        "text",
        PaintProps {
            text: Some("carbon-mini v2 hardcoded scene (no JS)".to_string()),
            font_size: Some(20.0),
            color: Some(0xFF11_1827),
            ..PaintProps::default()
        },
    );
    s.insert_node(1, 2, None);
    s.create_node(
        3,
        "view",
        PaintProps {
            background: Some(0xFF3B_82F6),
            border_radius: 6.0,
            ..PaintProps::default()
        },
    );
    s.insert_node(1, 3, None);
    s.create_node(
        4,
        "text",
        PaintProps {
            text: Some("Click me".to_string()),
            color: Some(0xFFFF_FFFF),
            font_size: Some(16.0),
            ..PaintProps::default()
        },
    );
    s.insert_node(3, 4, None);
    s.dirty = true;
}

fn register_host_imports(
    js_ctx: &JsContext,
    scene: Arc<Mutex<Scene>>,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
    text_engine: Rc<RefCell<text::TextEngine>>,
) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let global = ctx.globals();

        // console.log — emits to stderr when CARBON_MINI_TIMING=1, no-op otherwise.
        // Phase 1.5δ kept this routed through stderr so debug breadcrumbs can
        // surface during the GPU integration smoke test without changing the
        // public API. Apps that always-log via console.log still pay zero in
        // production runs. Accepts any rquickjs Value (number/object/etc.)
        // and best-effort stringifies it so we don't throw on `console.log(x, y)`.
        // Format one rquickjs value the way `console.log` would. Used
        // for every level (log/info/warn/error/debug) so output stays
        // consistent. Best-effort: complex objects render as
        // [object] — apps wanting full structured logging can call
        // JSON.stringify() themselves.
        fn fmt_log_args(args: &[rquickjs::Value<'_>]) -> String {
            let mut buf = String::new();
            for (i, a) in args.iter().enumerate() {
                if i > 0 { buf.push(' '); }
                if let Some(s) = a.as_string() {
                    if let Ok(s) = s.to_string() { buf.push_str(&s); continue; }
                }
                if let Some(n) = a.as_number() {
                    buf.push_str(&n.to_string()); continue;
                }
                if let Some(b) = a.as_bool() { buf.push_str(&b.to_string()); continue; }
                if a.is_null() { buf.push_str("null"); continue; }
                if a.is_undefined() { buf.push_str("undefined"); continue; }
                if let Some(obj) = a.as_object() {
                    // Error-shaped: print message + (truncated) stack.
                    let name: Option<String> = obj.get("name").ok();
                    let msg: Option<String> = obj.get("message").ok();
                    let stack: Option<String> = obj.get("stack").ok();
                    if msg.is_some() || stack.is_some() {
                        if let (Some(n), Some(m)) = (&name, &msg) {
                            buf.push_str(&format!("{n}: {m}"));
                        } else if let Some(m) = &msg {
                            buf.push_str(m);
                        }
                        if let Some(s) = &stack {
                            // Truncate stack to first ~5 frames so
                            // pages of stack don't drown out following
                            // log lines.
                            let truncated: String = s
                                .lines()
                                .take(6)
                                .collect::<Vec<_>>()
                                .join("\n");
                            buf.push('\n');
                            buf.push_str(&truncated);
                        }
                        continue;
                    }
                    // Plain object: ask JS to JSON.stringify it.
                    let ctx = obj.ctx();
                    // We have to be careful — stringify itself can throw on
                    // cycles. Fall back to "[object]" on failure.
                    let json_obj = ctx.globals().get::<_, rquickjs::Object>("JSON").ok();
                    if let Some(json) = json_obj {
                        let stringify: Option<rquickjs::Function> = json.get("stringify").ok();
                        if let Some(f) = stringify {
                            if let Ok(s) = f.call::<_, String>((obj.clone(),)) {
                                if !s.is_empty() {
                                    buf.push_str(&s);
                                    continue;
                                }
                            }
                        }
                    }
                }
                buf.push_str("[object]");
            }
            buf
        }
        // console.log / console.info are gated behind CARBON_MINI_DEBUG so the
        // default console stays clean (apps tend to log a lot). console.warn /
        // console.error always print — those are genuine issues worth seeing.
        let console_log = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            if std::env::var_os("CARBON_MINI_DEBUG").is_some() {
                eprintln!("[js] {}", fmt_log_args(&args.0));
            }
        })
            .map_err(|e| anyhow!("console.log: {e}"))?;
        let console_info = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            if std::env::var_os("CARBON_MINI_DEBUG").is_some() {
                eprintln!("[js info] {}", fmt_log_args(&args.0));
            }
        })
            .map_err(|e| anyhow!("console.info: {e}"))?;
        let console_warn = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            eprintln!("[js warn] {}", fmt_log_args(&args.0));
        })
            .map_err(|e| anyhow!("console.warn: {e}"))?;
        let console_error = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            eprintln!("[js error] {}", fmt_log_args(&args.0));
        })
            .map_err(|e| anyhow!("console.error: {e}"))?;
        let console_debug = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            if std::env::var_os("CARBON_MINI_DEBUG").is_some() {
                eprintln!("[js debug] {}", fmt_log_args(&args.0));
            }
        })
            .map_err(|e| anyhow!("console.debug: {e}"))?;
        let console = rquickjs::Object::new(ctx.clone()).map_err(|e| anyhow!("console: {e}"))?;
        console
            .set("log", console_log)
            .map_err(|e| anyhow!("console set: {e}"))?;
        console.set("info", console_info).map_err(|e| anyhow!("console.info set: {e}"))?;
        console.set("warn", console_warn).map_err(|e| anyhow!("console.warn set: {e}"))?;
        console.set("error", console_error).map_err(|e| anyhow!("console.error set: {e}"))?;
        console.set("debug", console_debug).map_err(|e| anyhow!("console.debug set: {e}"))?;
        // Stubs for non-essential methods that some libraries reach
        // for; avoids "console.X is not a function" crashes.
        let noop = Function::new(ctx.clone(), || () ).map_err(|e| anyhow!("noop: {e}"))?;
        for m in &["trace", "table", "dir", "group", "groupEnd", "groupCollapsed", "time", "timeEnd", "timeLog", "assert", "count", "countReset", "clear"] {
            let _ = console.set(*m, noop.clone());
        }
        global
            .set("console", console)
            .map_err(|e| anyhow!("set console: {e}"))?;

        // __cm_create_node(id, tag, propsJson)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64, tag: String, props_json: String| -> Result<(), rquickjs::Error> {
                    let props: PaintProps = serde_json::from_str(&props_json).unwrap_or_default();
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.create_node(id as u32, &tag, props);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("create_node: {e}"))?;
            global
                .set("__cm_create_node", f)
                .map_err(|e| anyhow!("set __cm_create_node: {e}"))?;
        }

        // __cm_set_text(id, text)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64, text: String| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.set_text(id as u32, text);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_text: {e}"))?;
            global
                .set("__cm_set_text", f)
                .map_err(|e| anyhow!("set __cm_set_text: {e}"))?;
        }

        // __cm_set_prop(id, key, valueJson)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64,
                      key: String,
                      value_json: String|
                      -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.set_prop(id as u32, &key, &value_json);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_prop: {e}"))?;
            global
                .set("__cm_set_prop", f)
                .map_err(|e| anyhow!("set __cm_set_prop: {e}"))?;
        }

        // __cm_reset_paint_props(id) — drop every paint-related prop on
        // a node back to defaults so the next set_prop pass sees a
        // clean slate. The reconciler calls this in commitUpdate before
        // re-applying className-resolved styles, fixing the bug where
        // state-variant styles (e.g. `data-active:bg-X`) from a stale
        // state would linger when the state transitioned away.
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.reset_paint_props(id as u32);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("reset_paint_props: {e}"))?;
            global
                .set("__cm_reset_paint_props", f)
                .map_err(|e| anyhow!("set __cm_reset_paint_props: {e}"))?;
        }

        // __cm_insert_node(parentId, childId, beforeId)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |parent: i64, child: i64, before: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let before_opt = if before < 0 { None } else { Some(before as u32) };
                    s.insert_node(parent as u32, child as u32, before_opt);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("insert_node: {e}"))?;
            global
                .set("__cm_insert_node", f)
                .map_err(|e| anyhow!("set __cm_insert_node: {e}"))?;
        }

        // __cm_remove_node(id)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.remove_node(id as u32);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("remove_node: {e}"))?;
            global
                .set("__cm_remove_node", f)
                .map_err(|e| anyhow!("set __cm_remove_node: {e}"))?;
        }

        // __cm_set_root(id)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.set_root(id as u32);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_root: {e}"))?;
            global
                .set("__cm_set_root", f)
                .map_err(|e| anyhow!("set __cm_set_root: {e}"))?;
        }

        // __cm_request_paint()
        {
            let proxy = proxy.clone();
            let f = Function::new(ctx.clone(), move || -> Result<(), rquickjs::Error> {
                let _ = proxy.send_event(UserEvent::RequestPaint);
                Ok(())
            })
            .map_err(|e| anyhow!("request_paint: {e}"))?;
            global
                .set("__cm_request_paint", f)
                .map_err(|e| anyhow!("set __cm_request_paint: {e}"))?;
        }

        // __cm_apply_ops(opsJson) — BATCHED scene mutations. The react-mini
        // adapter buffers every create/setText/setProp/insert/remove/setRoot
        // during a single reconciler commit and flushes them here in ONE call:
        // one FFI crossing, one JSON parse, one scene lock — instead of the
        // thousands of per-op round-trips a full IDE mount would otherwise do
        // (each per-op call paid FFI marshaling + a serde_json parse + a lock).
        // The per-op host fns above remain as the non-batched fallback.
        //
        // Op format: JSON array of [opcode, ...args]:
        //   0 create   [id, tag, propsJson]
        //   1 setText  [id, text]
        //   2 setProp  [id, key, valueJson]
        //   3 insert   [parent, child, before(-1 = append)]
        //   4 remove   [id]
        //   5 setRoot  [id]
        //   6 resetProps [id]
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |ops_json: String| -> Result<(), rquickjs::Error> {
                    let ops: Vec<Vec<serde_json::Value>> =
                        match serde_json::from_str(&ops_json) {
                            Ok(v) => v,
                            Err(_) => return Ok(()),
                        };
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let num = |op: &Vec<serde_json::Value>, i: usize| -> i64 {
                        op.get(i).and_then(|v| v.as_i64()).unwrap_or(0)
                    };
                    let strv = |op: &Vec<serde_json::Value>, i: usize| -> String {
                        op.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string()
                    };
                    for op in &ops {
                        match op.first().and_then(|v| v.as_i64()).unwrap_or(-1) {
                            0 => {
                                let id = num(op, 1) as u32;
                                let tag = strv(op, 2);
                                let tag = if tag.is_empty() { "view".to_string() } else { tag };
                                let props: PaintProps =
                                    serde_json::from_str(&strv(op, 3)).unwrap_or_default();
                                s.create_node(id, &tag, props);
                            }
                            1 => s.set_text(num(op, 1) as u32, strv(op, 2)),
                            2 => {
                                let id = num(op, 1) as u32;
                                let key = strv(op, 2);
                                let val = strv(op, 3);
                                s.set_prop(id, &key, &val);
                            }
                            3 => {
                                let before = num(op, 3);
                                let before_opt = if before < 0 { None } else { Some(before as u32) };
                                s.insert_node(num(op, 1) as u32, num(op, 2) as u32, before_opt);
                            }
                            4 => s.remove_node(num(op, 1) as u32),
                            5 => s.set_root(num(op, 1) as u32),
                            6 => s.reset_paint_props(num(op, 1) as u32),
                            _ => {}
                        }
                    }
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("apply_ops: {e}"))?;
            global
                .set("__cm_apply_ops", f)
                .map_err(|e| anyhow!("set __cm_apply_ops: {e}"))?;
        }

        // __cm_set_scroll_y(id, y) — programmatic scroll. Sets the
        // node's vertical scroll offset (clamped to its valid range)
        // and requests a paint. Used by the terminal pane to snap the
        // viewport to the bottom whenever new output arrives, so the
        // user sees the live tail without having to scroll manually
        // — and mouse-wheel-up still works to read scrollback because
        // the renderer's wheel handler writes to the same `scroll_y`.
        //
        // Pass `Number.POSITIVE_INFINITY` (or any huge number) to
        // scroll to the bottom; the setter clamps to
        // (content_height - viewport_height).
        //
        // IMPORTANT: triggers a synchronous compute_layout FIRST so the
        // clamp uses the up-to-date content height. Callers that just
        // mutated text via __cm_set_text expect the new content height
        // to be reflected — without this layout pass, the clamp uses
        // the stale "max scroll" from the previous frame and the snap
        // doesn't reach the new bottom.
        {
            let scene = scene.clone();
            let text_engine = text_engine.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64, y: f64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let (w, h) = HOST_WINDOW_SIZE
                        .lock()
                        .map(|m| *m)
                        .unwrap_or((1280.0, 800.0));
                    s.compute_layout(w, h, &mut text_engine.borrow_mut());
                    let _ = s.set_scroll_y(id as u32, y as f32);
                    s.repaint_dirty = true;
                    let _ = proxy.send_event(UserEvent::RequestPaint);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_scroll_y: {e}"))?;
            global
                .set("__cm_set_scroll_y", f)
                .map_err(|e| anyhow!("set __cm_set_scroll_y: {e}"))?;
        }

        // __cm_load_font(path) → boolean (true on success).
        // Registers a font into the text engine's fallback stack. The
        // newly-loaded font is preferred over already-loaded ones for
        // any glyph it provides; the embedded Roboto-Latin subset stays
        // as the final backstop. After loading, invalidates the per-
        // node cached layouts (Taffy needs to re-measure) and triggers
        // a repaint.
        //
        // Pair this with __cm_load_font_bytes(name, base64) for app-bundled
        // fonts that don't live at a fs-resolvable path.
        {
            let text_engine = text_engine.clone();
            let scene = scene.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |path: String| -> Result<bool, rquickjs::Error> {
                    let mut te = text_engine.borrow_mut();
                    let ok = te.load_font_path(std::path::Path::new(&path));
                    if ok {
                        // Font change invalidates every previously
                        // computed glyph cache key implicitly (new fonts
                        // get new font_idx) but the LAYOUT cached on
                        // each node measured glyph widths assuming the
                        // old stack — so mark the scene dirty so the
                        // next paint runs a fresh compute_layout.
                        scene.lock().unwrap_or_else(|e| e.into_inner()).dirty = true; scene.lock().unwrap_or_else(|e| e.into_inner()).layout_valid = false;
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                    Ok(ok)
                },
            )
            .map_err(|e| anyhow!("load_font: {e}"))?;
            global
                .set("__cm_load_font", f)
                .map_err(|e| anyhow!("set __cm_load_font: {e}"))?;
        }

        // __cm_load_font_bytes(base64_bytes) → boolean.
        // Same as __cm_load_font but accepts raw base64-encoded TTF/OTF
        // bytes. Use when the font is bundled as an asset and you don't
        // want to write it to disk first.
        {
            let text_engine = text_engine.clone();
            let scene = scene.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |b64: String| -> Result<bool, rquickjs::Error> {
                    use base64::engine::Engine as _;
                    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                        Ok(b) => b,
                        Err(_) => return Ok(false),
                    };
                    let mut te = text_engine.borrow_mut();
                    let ok = te.load_font_bytes(bytes);
                    if ok {
                        scene.lock().unwrap_or_else(|e| e.into_inner()).dirty = true; scene.lock().unwrap_or_else(|e| e.into_inner()).layout_valid = false;
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                    Ok(ok)
                },
            )
            .map_err(|e| anyhow!("load_font_bytes: {e}"))?;
            global
                .set("__cm_load_font_bytes", f)
                .map_err(|e| anyhow!("set __cm_load_font_bytes: {e}"))?;
        }

        // __cm_load_system_font(familyChain, preferMono) → matched path | "".
        // Resolves a CSS font-family chain (e.g. the one xterm/terminals set,
        // `"JetBrainsMono Nerd Font","Hack Nerd Font Mono",monospace`) against
        // the OS font directories and loads the first match into fontdue. This
        // is how unmodified apps that ask for a system/Nerd font get the right
        // glyphs (icons, box-drawing, proper monospace) — without bundling the
        // font. Results are cached per chain so repeated font-set calls are
        // cheap.
        {
            let text_engine = text_engine.clone();
            let scene = scene.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |chain: String, prefer_mono: bool| -> String {
                    thread_local! {
                        // chains already processed (don't re-scan)
                        static LOADED_CHAINS: std::cell::RefCell<std::collections::HashSet<String>> =
                            std::cell::RefCell::new(std::collections::HashSet::new());
                        // font FILES already loaded into the stack (dedup)
                        static LOADED_PATHS: std::cell::RefCell<std::collections::HashSet<String>> =
                            std::cell::RefCell::new(std::collections::HashSet::new());
                        // whether the broad-coverage fallback (braille / box-
                        // drawing) has been loaded yet
                        static COVERAGE_LOADED: std::cell::RefCell<bool> =
                            std::cell::RefCell::new(false);
                    }
                    fn norm(s: &str) -> String {
                        s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
                    }
                    fn find_best(fam: &str, prefer_mono: bool, dirs: &[String]) -> Option<std::path::PathBuf> {
                        let mut best: Option<(i32, std::path::PathBuf)> = None;
                        for dir in dirs {
                            let Ok(rd) = std::fs::read_dir(dir) else { continue };
                            for ent in rd.flatten() {
                                let path = ent.path();
                                let ext_ok = path.extension().and_then(|e| e.to_str())
                                    .map(|e| { let e = e.to_ascii_lowercase(); e == "ttf" || e == "otf" })
                                    .unwrap_or(false);
                                if !ext_ok { continue; }
                                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                                let fname = norm(stem);
                                if !fname.contains(fam) { continue; }
                                let mut score = 0i32;
                                if fname == fam { score += 100; }
                                if fname.starts_with(fam) { score += 30; }
                                if fname.contains("regular") { score += 20; }
                                if prefer_mono && fname.contains("mono") { score += 25; }
                                if fname.contains("bold") || fname.contains("italic")
                                    || fname.contains("oblique") || fname.contains("light")
                                    || fname.contains("thin") || fname.contains("extra")
                                    || fname.contains("semi") || fname.contains("medium")
                                { score -= 30; }
                                if fname.contains("wght") { score -= 8; }
                                let take = match &best { Some((bs, _)) => score > *bs, None => true };
                                if take { best = Some((score, path.clone())); }
                            }
                        }
                        best.map(|(_, p)| p)
                    }
                    if LOADED_CHAINS.with(|l| l.borrow().contains(&chain)) {
                        return String::new();
                    }
                    LOADED_CHAINS.with(|l| l.borrow_mut().insert(chain.clone()));

                    let mut dirs: Vec<String> = Vec::new();
                    if let Ok(la) = std::env::var("LOCALAPPDATA") {
                        dirs.push(format!("{}\\Microsoft\\Windows\\Fonts", la));
                    }
                    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
                    dirs.push(format!("{}\\Fonts", sysroot));

                    // Try to load a font file once (dedup by path).
                    let load_once = |path: &std::path::Path| -> bool {
                        let key = path.to_string_lossy().to_string();
                        if LOADED_PATHS.with(|l| l.borrow().contains(&key)) {
                            return false;
                        }
                        let ok = text_engine.borrow_mut().load_font_path(path);
                        if ok { LOADED_PATHS.with(|l| l.borrow_mut().insert(key)); }
                        ok
                    };

                    let mut first_path = String::new();
                    let mut loaded = 0usize;
                    // Load EVERY family in the chain that resolves to a file —
                    // a real font-fallback stack, not just the first match. The
                    // first load is the primary; later ones cover glyphs the
                    // primary lacks (e.g. one font has Nerd icons, another has
                    // braille). Cap to keep the stack small.
                    for fam_raw in chain.split(',') {
                        if loaded >= 4 { break; }
                        let trimmed = fam_raw.trim().trim_matches('"').trim_matches('\'');
                        let fam = norm(trimmed);
                        if fam.is_empty()
                            || fam == "monospace" || fam == "serif" || fam == "sansserif"
                            || fam == "system" || fam == "systemui" || fam == "ui" || fam == "inherit"
                        {
                            continue;
                        }
                        if let Some(path) = find_best(&fam, prefer_mono, &dirs) {
                            if load_once(&path) {
                                if first_path.is_empty() { first_path = path.to_string_lossy().to_string(); }
                                loaded += 1;
                            }
                        }
                    }

                    // Broad-coverage fallback (once): the chains apps request
                    // rarely include a font with Braille Patterns / box-drawing,
                    // yet terminals (winfetch/neofetch logos, TUIs) use them
                    // heavily. Cascadia Code / Consolas / DejaVu Sans Mono ship
                    // those blocks; load the first available as the last resort
                    // so missing glyphs fall back to real shapes instead of
                    // .notdef boxes.
                    if !COVERAGE_LOADED.with(|c| *c.borrow()) {
                        for cov in ["cascadiacode", "cascadiamono", "dejavusansmono", "consola"] {
                            if let Some(path) = find_best(cov, true, &dirs) {
                                if load_once(&path) {
                                    COVERAGE_LOADED.with(|c| *c.borrow_mut() = true);
                                    break;
                                }
                            }
                        }
                    }

                    if loaded > 0 {
                        if let Ok(mut s) = scene.lock() { s.dirty = true; s.layout_valid = false; }
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                    first_path
                },
            )
            .map_err(|e| anyhow!("load_system_font: {e}"))?;
            global
                .set("__cm_load_system_font", f)
                .map_err(|e| anyhow!("set __cm_load_system_font: {e}"))?;
        }

        // __cm_layout_box(id) → "x,y,w,h" (or empty if unknown).
        // Triggers a synchronous layout pass against the last known
        // window dimensions, then reads the node's absolute box from
        // taffy. DOM-shim's CarbonElement.getBoundingClientRect /
        // .offsetWidth / .clientHeight all route here so libraries
        // like react-resizable-panels (which measure their container
        // every render) get real values instead of zeros.
        //
        // Stringified return so we don't pay a JS-object alloc per
        // call; the shim parses the four-number string back.
        {
            let scene = scene.clone();
            let text_engine = text_engine.clone();
            let f = Function::new(ctx.clone(), move |id: u32| -> String {
                let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                // Use last known window size — host_app keeps it in sync
                // on every WindowEvent::Resized. Fall back to a sane
                // default so callers querying before the first paint
                // still get nonzero numbers.
                let (w, h) = HOST_WINDOW_SIZE
                    .lock()
                    .map(|m| *m)
                    .unwrap_or((1280.0, 800.0));
                s.compute_layout(w, h, &mut text_engine.borrow_mut());
                match s.absolute_box(id) {
                    Some((x, y, w, h)) => format!("{},{},{},{}", x, y, w, h),
                    None => String::new(),
                }
            })
            .map_err(|e| anyhow!("layout_box: {e}"))?;
            global
                .set("__cm_layout_box", f)
                .map_err(|e| anyhow!("set __cm_layout_box: {e}"))?;
        }

        // __cm_dump_tree() — DEBUG: print every node's id, tag, computed
        // box, parent, and a few key style props to stderr. Used during
        // bring-up to see why some elements render blank.
        {
            let scene = scene.clone();
            let text_engine = text_engine.clone();
            let f = Function::new(ctx.clone(), move || -> String {
                let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                let (w, h) = HOST_WINDOW_SIZE
                    .lock()
                    .map(|m| *m)
                    .unwrap_or((1280.0, 800.0));
                s.compute_layout(w, h, &mut text_engine.borrow_mut());
                let mut out = String::new();
                fn walk(s: &crate::scene::Scene, id: u32, depth: usize, out: &mut String) {
                    let Some(n) = s.nodes.get(&id) else { return; };
                    let box_str = n.computed_layout
                        .map(|l| format!("box=({:.0},{:.0}) {:.0}x{:.0}", l.location.x, l.location.y, l.size.width, l.size.height))
                        .unwrap_or_else(|| "box=NONE".to_string());
                    let bg = n.props.background.map(|c| format!(" bg=#{:08x}", c)).unwrap_or_default();
                    let drag = if n.props.drag_region { " drag-region=true".to_string() } else { String::new() };
                    let h_prop = String::new();
                    let w_prop = String::new();
                    let text = n.props.text.as_ref().map(|t| format!(" text={:?}", t.chars().take(40).collect::<String>())).unwrap_or_default();
                    // TEMP DEBUG: surface font props on text nodes so we can
                    // diagnose the intra-word gap (mono-cell-centering) issue.
                    let fontdbg = if n.props.text.is_some() {
                        let fam = n.props.font_family.as_deref().unwrap_or("(none)");
                        let mono = n.props.font_family.as_deref()
                            .map(crate::text::TextEngine::family_is_mono).unwrap_or(false);
                        format!(" font_family={:?} mono={} font_size={:?} ls={:?}",
                            fam, mono, n.props.font_size, n.props.letter_spacing)
                    } else { String::new() };
                    out.push_str(&format!("{}id={} tag={} {}{}{}{}{}{}{}\n", " ".repeat(depth*2), id, n.tag, box_str, bg, text, fontdbg, drag, h_prop, w_prop));
                    for &c in &n.children {
                        walk(s, c, depth + 1, out);
                    }
                }
                walk(&s, s.root, 0, &mut out);
                out
            })
            .map_err(|e| anyhow!("dump_tree: {e}"))?;
            global
                .set("__cm_dump_tree", f)
                .map_err(|e| anyhow!("set __cm_dump_tree: {e}"))?;
        }

        // TEMP DEBUG: __cm_text_probe(text [, size]) — per-glyph metrics.
        {
            let text_engine = text_engine.clone();
            let f = Function::new(ctx.clone(), move |text: String, size: rquickjs::function::Opt<f32>| -> String {
                let px = size.0.unwrap_or(13.0);
                text_engine.borrow_mut().debug_probe(&text, px)
            })
            .map_err(|e| anyhow!("text_probe: {e}"))?;
            global
                .set("__cm_text_probe", f)
                .map_err(|e| anyhow!("set __cm_text_probe: {e}"))?;
        }

        // ─── Native CanvasRenderingContext2D (CPU, tiny-skia) ────────────────────
        // Backs <canvas>.getContext('2d') / OffscreenCanvas for unmodified npm
        // packages. See canvas2d.rs. Surfaces are keyed by the canvas element's
        // scene-node id.
        {
            // __cm_canvas2d_create(id, w, h)
            let f = Function::new(ctx.clone(), move |id: i64, w: i64, h: i64| {
                crate::canvas2d::create(id as u32, w.max(1) as u32, h.max(1) as u32);
            })
            .map_err(|e| anyhow!("c2d_create: {e}"))?;
            global.set("__cm_canvas2d_create", f).map_err(|e| anyhow!("set c2d_create: {e}"))?;

            // __cm_canvas2d_resize(id, w, h)
            let f = Function::new(ctx.clone(), move |id: i64, w: i64, h: i64| {
                crate::canvas2d::resize(id as u32, w.max(1) as u32, h.max(1) as u32);
            })
            .map_err(|e| anyhow!("c2d_resize: {e}"))?;
            global.set("__cm_canvas2d_resize", f).map_err(|e| anyhow!("set c2d_resize: {e}"))?;

            // __cm_canvas2d_destroy(id)
            let f = Function::new(ctx.clone(), move |id: i64| {
                crate::canvas2d::destroy(id as u32);
            })
            .map_err(|e| anyhow!("c2d_destroy: {e}"))?;
            global.set("__cm_canvas2d_destroy", f).map_err(|e| anyhow!("set c2d_destroy: {e}"))?;

            // __cm_canvas2d_flush(id, commandsJson)
            {
                let proxy = proxy.clone();
                let text_engine = text_engine.clone();
                let f = Function::new(ctx.clone(), move |id: i64, json: String| {
                    crate::canvas2d::flush(id as u32, &json, &mut text_engine.borrow_mut());
                    let _ = proxy.send_event(UserEvent::RequestPaint);
                })
                .map_err(|e| anyhow!("c2d_flush: {e}"))?;
                global.set("__cm_canvas2d_flush", f).map_err(|e| anyhow!("set c2d_flush: {e}"))?;
            }

            // __cm_canvas2d_measure_text(text, px, mono) -> width
            {
                let text_engine = text_engine.clone();
                let f = Function::new(ctx.clone(), move |text: String, px: f64, mono: bool| -> f64 {
                    crate::canvas2d::measure_text(&mut text_engine.borrow_mut(), &text, px as f32, mono) as f64
                })
                .map_err(|e| anyhow!("c2d_measure: {e}"))?;
                global.set("__cm_canvas2d_measure_text", f).map_err(|e| anyhow!("set c2d_measure: {e}"))?;
            }

            // __cm_canvas2d_get_pixels(id, x, y, w, h) -> base64(RGBA)
            let f = Function::new(ctx.clone(), move |id: i64, x: i64, y: i64, w: i64, h: i64| -> String {
                use base64::Engine;
                let px = crate::canvas2d::get_pixels(id as u32, x as i32, y as i32, w.max(0) as u32, h.max(0) as u32);
                base64::engine::general_purpose::STANDARD.encode(&px)
            })
            .map_err(|e| anyhow!("c2d_get_pixels: {e}"))?;
            global.set("__cm_canvas2d_get_pixels", f).map_err(|e| anyhow!("set c2d_get_pixels: {e}"))?;

            // __cm_canvas2d_put_pixels(id, base64, srcW, srcH, dx, dy, dirtyJson)
            // dirtyJson = "dirtyX,dirtyY,dirtyW,dirtyH" (the putImageData dirty
            // rect; packed as one string to keep the arg count modest).
            {
                let proxy = proxy.clone();
                let f = Function::new(ctx.clone(), move |id: i64, b64: String, sw: i64, sh: i64, dx: i64, dy: i64, dirty: String| {
                    use base64::Engine;
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                        let mut d = dirty.split(',').map(|s| s.trim().parse::<i32>().unwrap_or(0));
                        let dirty_x = d.next().unwrap_or(0);
                        let dirty_y = d.next().unwrap_or(0);
                        let dirty_w = d.next().unwrap_or(sw as i32);
                        let dirty_h = d.next().unwrap_or(sh as i32);
                        crate::canvas2d::put_pixels(
                            id as u32, &bytes, sw.max(0) as u32, sh.max(0) as u32, dx as i32, dy as i32,
                            dirty_x, dirty_y, dirty_w, dirty_h,
                        );
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                })
                .map_err(|e| anyhow!("c2d_put_pixels: {e}"))?;
                global.set("__cm_canvas2d_put_pixels", f).map_err(|e| anyhow!("set c2d_put_pixels: {e}"))?;
            }
        }

        // ─── GPU canvas host imports (Phase 1 — OPTIONAL via 'gpu' feature) ───────
        // Phase 1A disables GPU feature to eliminate 2.5 MB wgpu dependency.
        // Phase 2: migrates to carbon-canvas plugin with dynamic loading.
        #[cfg(feature = "gpu")]
        {
            // Lazy: the GPU device is only created on the FIRST __carbon_canvas_create
            // call. UI-only apps that never instantiate a <canvas> never trigger
            // wgpu init, so cold-start is unchanged. See gpu.rs.

            // __carbon_canvas_create(width, height) -> id
            {
                let f = Function::new(
                    ctx.clone(),
                    move |w: i64, h: i64| -> Result<i64, rquickjs::Error> {
                        match gpu::create_surface(w.max(1) as u32, h.max(1) as u32) {
                            Ok(id) => Ok(id as i64),
                            Err(e) => {
                                eprintln!("[carbon-mini] canvas create failed: {e:#}");
                                Ok(0) // 0 = invalid id; JS-side checks for this
                            }
                        }
                    },
                )
                .map_err(|e| anyhow!("canvas_create: {e}"))?;
                global
                    .set("__carbon_canvas_create", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_create: {e}"))?;
            }

            // __carbon_canvas_resize(id, width, height)
            {
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64, w: i64, h: i64| -> Result<(), rquickjs::Error> {
                        let _ = gpu::resize_surface(id as u32, w.max(1) as u32, h.max(1) as u32);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_resize: {e}"))?;
                global
                    .set("__carbon_canvas_resize", f)
                    .map_err(|e| anyhow!("set __canvas_resize: {e}"))?;
            }

            // __carbon_canvas_clear(id, r, g, b, a)
            {
                let proxy = proxy.clone();
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64, r: f64, g: f64, b: f64, a: f64| -> Result<(), rquickjs::Error> {
                        let _ = gpu::clear_surface(id as u32, r as f32, g as f32, b as f32, a as f32);
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_clear: {e}"))?;
                global
                    .set("__carbon_canvas_clear", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_clear: {e}"))?;
            }

            // __carbon_canvas_destroy(id)
            {
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64| -> Result<(), rquickjs::Error> {
                        gpu::destroy_surface(id as u32);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_destroy: {e}"))?;
                global
                    .set("__carbon_canvas_destroy", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_destroy: {e}"))?;
            }

            // __carbon_canvas_execute_commands(id, jsonString) — Phase 1.5δ entry
            // point. Parses the command list and runs it against the surface's
            // executor (lazy-init on first call). Errors are logged in Rust;
            // we return silently so a malformed command never crashes JS.
            {
                let proxy = proxy.clone();
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64, json: String| -> Result<(), rquickjs::Error> {
                        gpu::execute_commands_json(id as u32, &json);
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_execute_commands: {e}"))?;
                global
                    .set("__carbon_canvas_execute_commands", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_execute_commands: {e}"))?;
            }
        }

        // ─── requestAnimationFrame / cancelAnimationFrame ────────────────
        //
        // We don't have a DOM. The model: each rAF call appends the JS
        // callback to a queue and posts a RequestPaint user event. On the
        // next Event::RedrawRequested, the event-loop drains the queue,
        // invokes each callback with the current timestamp, then performs
        // the paint. cancelAnimationFrame walks the queue and removes by
        // handle.
        //
        // The queue is stored on the JS side as a Map<handle, Function> on
        // globalThis (because rquickjs Function values can't be moved
        // through Rust-side state easily). Rust orchestrates by calling
        // `__cm_drain_raf` from the redraw handler.
        {
            // Initialize the JS-side support: a Map of pending rAF
            // callbacks, a counter for handles, and a drain helper that
            // the redraw path invokes once per frame.
            ctx.eval::<(), _>(
                br#"
                (function(){
                  if (globalThis.__cm_raf_queue) return;
                  const queue = new Map();
                  let nextHandle = 1;
                  globalThis.requestAnimationFrame = function(cb) {
                    if (typeof cb !== 'function') return 0;
                    const h = nextHandle++;
                    queue.set(h, cb);
                    if (typeof __cm_request_paint === 'function') __cm_request_paint();
                    return h;
                  };
                  globalThis.cancelAnimationFrame = function(h) {
                    queue.delete(h);
                  };
                  globalThis.__cm_raf_queue = queue;
                  globalThis.__cm_drain_raf = function(now) {
                    if (queue.size === 0) return false;
                    // Snapshot + clear so callbacks scheduling new rAFs don't recurse.
                    const cbs = Array.from(queue.values());
                    queue.clear();
                    for (let i = 0; i < cbs.length; i++) {
                      try { cbs[i](now); } catch (e) {}
                    }
                    return true;
                  };
                })();
                "#.as_slice(),
            )
            .ok();
        }

        // ─── Phase 3: register fast-math classes (lazy, opt-in) ──────────
        // Bundles call `globalThis.__cm_register_math()` during init to
        // install Vector3/Matrix4/Quaternion/Box3/Frustum/Color globals.
        // The carbon-fast-import Vite plugin emits this call automatically
        // when it detects rewritten three.js imports. UI-only apps don't
        // need to call it — keeping the prototype allocations off the
        // cold path entirely.
        {
            let f = Function::new(
                ctx.clone(),
                move |ctx: rquickjs::Ctx<'_>| -> Result<(), rquickjs::Error> {
                    carbon_fast_math::register_math(&ctx)
                        .map_err(|_| rquickjs::Error::Exception)
                },
            )
            .map_err(|e| anyhow!("register_math: {e}"))?;
            global
                .set("__cm_register_math", f)
                .map_err(|e| anyhow!("set __cm_register_math: {e}"))?;
        }

        Ok(())
    })?;
    Ok(())
}

// ─── Plugin loader plumbing ────────────────────────────────────────────────

/// Read just the [app] section from carbon.toml — name + version. Best-effort:
/// returns ("", "") if the file is missing or unparseable, matching the
/// runtime's "no carbon.toml is fine" stance.
fn read_app_metadata(project_dir: &PathBuf) -> (String, String) {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return (String::new(), String::new()),
    };
    // We intentionally avoid pulling in carbon-core's full Config here —
    // older carbon.toml files in the test fixtures sometimes lack
    // [app.window] which carbon-core requires. A minimal local schema with
    // only the fields we need is more forgiving.
    #[derive(serde::Deserialize, Default)]
    struct LocalApp {
        #[serde(default)]
        name: String,
        #[serde(default)]
        version: String,
    }
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        app: LocalApp,
    }
    let cfg: LocalCfg = toml::from_str(&text).unwrap_or_default();
    (cfg.app.name, cfg.app.version)
}

/// Initial window dimensions in logical pixels. Reads `[window]` from
/// carbon.toml; otherwise returns sensible desktop-app defaults (1100×720).
/// Always returns positive values — never zero or negative.
fn read_window_size(project_dir: &PathBuf) -> (f64, f64) {
    let cfg = read_window_cfg(project_dir);
    (cfg.0, cfg.1)
}

/// Returns (width, height, decorated). `decorated = false` lets the React
/// shell render its own title bar / window controls — terax-style apps
/// expect this because their layout starts at viewport y=0.
fn read_window_cfg(project_dir: &PathBuf) -> (f64, f64, bool) {
    let default = (1100.0_f64, 720.0_f64, true);
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return default,
    };
    #[derive(serde::Deserialize, Default)]
    struct WinSection {
        width: Option<f64>,
        height: Option<f64>,
        decorated: Option<bool>,
    }
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        window: WinSection,
    }
    let cfg: LocalCfg = toml::from_str(&text).unwrap_or_default();
    let w = cfg.window.width.unwrap_or(default.0).max(320.0);
    let h = cfg.window.height.unwrap_or(default.1).max(240.0);
    let decorated = cfg.window.decorated.unwrap_or(default.2);
    (w, h, decorated)
}

/// Read [plugins] from carbon.toml. Returns an empty map if carbon.toml is
/// missing, has no [plugins] section, or fails to parse the section. The
/// loader treats an empty map as a no-op.
fn read_plugins_section(
    project_dir: &PathBuf,
) -> std::collections::BTreeMap<String, carbon_core::config::PluginEntry> {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Default::default(),
    };
    // Local schema mirroring core::config::PluginsSection — gives us a
    // non-strict parse that ignores all the other top-level sections.
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        plugins: std::collections::BTreeMap<String, carbon_core::config::PluginEntry>,
    }
    match toml::from_str::<LocalCfg>(&text) {
        Ok(c) => c.plugins,
        Err(e) => {
            // A parse error in [plugins] is worth surfacing — silently
            // skipping would hide typos.
            eprintln!(
                "[carbon-mini-plugin] WARNING: failed to parse [plugins] in {}: {e}",
                path.display()
            );
            Default::default()
        }
    }
}

/// Install the JS-side `__carbon_on_event` dispatcher and the `carbon.on`
/// subscription API. Plugins push events from worker threads via
/// `app->push_event(name, payload)`; our event-loop handler forwards them
/// here as `__carbon_on_event(name, payloadJson)` calls.
fn install_carbon_event_dispatcher(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        ctx.eval::<(), _>(
            br#"
            (function(){
              if (globalThis.__carbon_on_event) return;
              const handlers = new Map(); // name -> Set<fn>
              globalThis.carbon = globalThis.carbon || {};
              globalThis.carbon.on = function(name, fn) {
                if (typeof name !== 'string' || typeof fn !== 'function') {
                  throw new TypeError('carbon.on(name, fn): name must be string, fn must be function');
                }
                let set = handlers.get(name);
                if (!set) { set = new Set(); handlers.set(name, set); }
                set.add(fn);
                return function unsubscribe() { handlers.get(name)?.delete(fn); };
              };
              globalThis.__carbon_on_event = function(name, payloadJson) {
                const set = handlers.get(name);
                if (!set || set.size === 0) return;
                let payload = null;
                try { payload = (payloadJson === '' || payloadJson == null) ? null : JSON.parse(payloadJson); }
                catch (e) { /* keep payload null */ }
                // Snapshot to allow handlers to unsubscribe during dispatch.
                for (const h of Array.from(set)) {
                  try { h(payload, name); } catch (e) {
                    if (typeof console !== 'undefined' && console.error) console.error(e);
                  }
                }
              };
            })();
            "#.as_slice(),
        ).map_err(|e| anyhow!("install __carbon_on_event: {e}"))?;
        Ok(())
    })?;
    Ok(())
}

/// Minimal JSON-string escape for embedding a UTF-8 string into a JS source
/// snippet wrapped in double quotes. We use this to build the call site for
/// `__carbon_on_event(name, payloadJson)` from a plugin event.
///
/// We reach for hand-rolled escape rather than `serde_json::to_string` so
/// the surrounding quotes are added by the caller — keeps the call sites
/// readable at the string-literal level.
fn json_escape(s: &str) -> String {
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
