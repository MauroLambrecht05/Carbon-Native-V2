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
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::keyboard::{Key, ModifiersState};
use tao::window::WindowBuilder;
use tiny_skia::{Paint, Rect, Transform};

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

// V1 spliced carbon/runtime/mod.rs in here textually (`include!`), so that
// unqualified `native::`, `platform::`, `os_theme::`, `host_exports::` and
// `plugin_loader::` call sites resolved without a module path. Those are five
// crates now. Re-binding the old names keeps every call site in this file
// exactly as it was, which is the point: a 4,400-line composition root is not
// where you want to also be rewriting a few hundred paths.
use carbon_runtime_contract::{UserEvent, WindowOp};
// ── Module map ──────────────────────────────────────────────────────────────
// Structured by CONCERN, not by binary. `carbon-mini` and `carbon-blitz` are
// two implementations of the same product, and both declare the SAME module
// names — `host`, `pump`, `trace` — pointing at different files. What differs
// is how each renders, not what a runtime is made of.
//
//   composition/   how the runtime assembles itself for a given app: read the
//                  manifest, restore or build a heap, load the bundle, decide
//                  which optional subsystems get registered.
//   presentation/  every surface something reaches in or out through —
//                  host/ is the __cm_* functions an app calls, js/ drives the
//                  engine from the event loop, timing/ is the startup trace.
//
// Nothing here is named `mini` or `blitz` except the two entry points, because
// the backend is an implementation of the renderer, not a kind of thing a
// product has.

// composition — siblings of this file
mod bundle;
mod cli;
mod features;
mod manifest;
// The file is named for the concern; the MODULE cannot be `snapshot` because
// this binary aliases the carbon-snapshot crate to that name, and every call
// site inside says `snapshot::`. The crate keeps the plain name.
#[path = "snapshot.rs"]
mod heap_snapshot;
// The winit/tao event loop's match arms — the single largest concern in this
// binary, so it gets its own file rather than a flat `use run_loop::*;`
// re-export: main() references `run_loop::State` explicitly.
mod run_loop;
// Raw-FFI QuickJS helpers used only by heap_snapshot's spike/build paths —
// split out because they're a distinct, self-contained concern (unsafe FFI
// over `*mut JSContext`) from the snapshot restore/build orchestration.
mod snapshot_spike;

// presentation
#[path = "../presentation/host/scene.rs"]
mod host;
#[path = "../presentation/host/image.rs"]
mod image_host;
#[path = "../presentation/js/pump.rs"]
mod pump;
#[path = "../presentation/timing/trace.rs"]
mod trace;
#[path = "../presentation/host/tree.rs"]
mod tree;

use bundle::*;
use features::*;
use heap_snapshot::*;
use host::*;
use image_host as async_image;
use manifest::*;
use pump::*;
use trace::*;
use tree::*;

use carbon_layout::scene;
use carbon_os as native;
use carbon_os::os_theme;
use carbon_platform as platform;
use carbon_plugin_host::host_exports;
use carbon_plugin_host::plugin_loader;
use carbon_snapshot as snapshot;
use scene::{PaintProps, Scene};

// Extracted to its own crate (no dependency on carbon-mini) — aliased so
// every existing `text::TextEngine` call site is unchanged.
use carbon_text_renderer as text;

fn main() -> Result<()> {
    prof_zone!("main");
    let t0 = Instant::now();
    let _ = START.set(t0);

    // Crash resilience: capture panics with a hook so the event loop's
    // catch_unwind can keep the window alive and log a useful message
    // instead of the process vanishing. Installed as early as possible.
    install_panic_hook();

    prof_zone!("args_resolve");
    // Argv parsing + the build-time tool modes (--compile-bundle,
    // --snapshot-spike, --snapshot-build) live in cli.rs: none of them touch
    // a window, JS runtime, or host import, so a build-time invocation exits
    // here without paying for (or risking) any of that.
    let cli::ParsedArgs {
        dev_mode,
        project_dir,
        window_opts_json,
    } = match cli::resolve()? {
        cli::Outcome::Exit(result) => return result,
        cli::Outcome::Run(parsed) => parsed,
    };

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
        if v.exists() {
            Some(v)
        } else {
            None
        }
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
    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::<UserEvent>::with_user_event().build();
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
            if let Some(t) = opts.get("title").and_then(|v| v.as_str()) {
                win_title = t.to_string();
            }
            if let Some(w) = opts.get("width").and_then(|v| v.as_f64()) {
                init_w = w;
            }
            if let Some(h) = opts.get("height").and_then(|v| v.as_f64()) {
                init_h = h;
            }
            if let Some(d) = opts.get("decorated").and_then(|v| v.as_bool()) {
                decorated = d;
            }
            if let Some(r) = opts.get("resizable").and_then(|v| v.as_bool()) {
                win_resizable = r;
            }
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

    // Force GTK to realize the window immediately. On Linux, tao's rwh_06
    // handle is None (HandleError::Unavailable) until the GdkWindow exists,
    // which GTK otherwise defers until .show() — but this runtime paints
    // before showing (see the non-Windows paint-then-show dance below), so
    // softbuffer needs a real handle first. realize() creates the X11/Wayland
    // backing window without mapping it on screen, so nothing is shown early.
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        use gtk::prelude::WidgetExt;
        use tao::platform::unix::WindowExtUnix;
        window.gtk_window().realize();
    }

    // softbuffer context bound to the window
    let context =
        softbuffer::Context::new(window.clone()).map_err(|e| anyhow!("softbuffer ctx: {e}"))?;
    timing_log("softbuffer_ctx", t0);
    // `mut` is only read by the non-Windows pre-show paint dance below
    // (RedrawRequested's resize/buffer_mut now go through run_loop::State's
    // owned field instead) — on Windows that dance is cfg'd out, so this
    // would otherwise warn as unused on this platform only.
    #[allow(unused_mut)]
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
        *g = (
            initial_size.width as f32 / sf,
            initial_size.height as f32 / sf,
        );
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
        // `lifecycle.before_bundle_eval` — the last moment at which a plugin can
        // install a global the app's own module-init code will see. Everything
        // else a plugin does happens in `lifecycle.register`, which runs AFTER
        // the bundle so plugin globals shadow app ones; this point exists for
        // the cases where that order is the wrong way round.
        plugin_registry.dispatch_before_bundle_eval();

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
                .map(|h| {
                    h.join()
                        .map_err(|_| anyhow!("bundle read worker panicked"))?
                })
                .unwrap_or_else(|| {
                    Err(anyhow!(
                        "bundle read worker missing for path {}",
                        path.display()
                    ))
                });
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
                let mut last_mtime = initial_meta.as_ref().ok().and_then(|m| m.modified().ok());
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
            eprintln!(
                "[carbon-mini] --dev: watching {} for changes",
                watch_path_log.display()
            );
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

    // Cloned before `scene` moves into `state` so ReloadBundle can call
    // load_and_eval_bundle without re-entering the borrow checker.
    let reload_path = bundle_path.clone();
    let reload_scene = scene.clone();

    // Everything the event loop closure used to capture by `move` — now
    // fields on a struct so the match arms (run_loop::State::handle_event)
    // can live in their own file. See run_loop.rs's module doc for the
    // field-by-field mapping from the old captures.
    let mut state = run_loop::State {
        window,
        surface,
        scene,
        text_engine,
        js_ctx,
        js_rt,
        // Move the host_app + registry into the event loop state. They live
        // for the runtime's full lifetime; only the shutdown handler drops them.
        host_app,
        plugin_registry,
        // Caller-owned pixmap: lifted out of `paint::paint` so the main loop
        // can hand the same RGBA8 buffer to plugin `before_paint` hooks (canvas
        // plugins blit GPU readbacks here) before the rasterizer paints UI on
        // top. Reused across frames; only re-allocates on resize.
        paint_canvas: None,
        // Paint-at-first-commit: the very first RedrawRequested paints the initial
        // (synchronously-rendered) tree WITHOUT first running the effect drain, so
        // the app is on screen ASAP. The deferred drain (useEffect / async data)
        // runs right after that first present and fills content in. Flips true once.
        first_paint_done: false,
        mouse_pos: (0.0_f32, 0.0_f32),
        modifiers_state: ModifiersState::empty(),
        // System clipboard handle. None on platforms where arboard fails to
        // connect (e.g. some headless environments) — Ctrl+C/V/X then no-op.
        clipboard: arboard::Clipboard::new().ok(),
        // Tracks the input being drag-selected. Set on MouseInput::Pressed
        // when the click lands on an input, cleared on Released. While Some,
        // CursorMoved updates the caret with `extend=true` so the selection
        // grows from the original anchor to the dragged-to position.
        dragging_input: None,
        // Node that received the most recent pointer-down. Used to route
        // pointer-move/up events back to the same target while the button is
        // held — matches DOM "implicit pointer capture" semantics. Separate
        // from `dragging_input` because that one is textarea-selection
        // specific; this one fires for any node with onMouseDown/Move/Up.
        pointer_down: None,
        // Multi-click tracking. A press counts as a continuation of the previous
        // click streak when (a) it lands on the same node within ~500 ms, and
        // (b) the cursor hasn't moved more than ~5 px from the previous press.
        // 1 = caret, 2 = select word, 3 = select all (≥3 wraps back to 1).
        last_click: None,
        click_streak: 0,
        reload_path,
        reload_scene,
        t0,
    };

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
            state.handle_event(event, control_flow);
        }));

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
            state.window.request_redraw();
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
