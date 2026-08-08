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

mod async_image;

// ── Split out of this file ──────────────────────────────────────────────────
// Each module is a verbatim extraction — the text moved, nothing was rewritten.
// `use super::*` in each gives it this file's imports, so the split needed no
// per-module import juggling. tests/launch.rs verifies the startup order did
// not change.
mod bundle;
mod features;
mod manifest;
mod js;
mod heap_snapshot;
mod host_imports;
mod scene_util;
mod timing;

use bundle::*;
use features::*;
use manifest::*;
use js::*;
use heap_snapshot::*;
use host_imports::*;
use scene_util::*;
use timing::*;
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
use carbon_snapshot as snapshot;
use carbon_layout::scene;
use scene::{PaintProps, Scene};

// Extracted to its own crate (no dependency on carbon-mini) — aliased so
// every existing `text::TextEngine` call site is unchanged.
use carbon_text_renderer as text;

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

