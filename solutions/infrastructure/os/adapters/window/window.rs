// Window control host imports for the carbon-native @/native/window TS
// module. Direct calls — NOT routed through the invoke channel. The TS
// wrapper in the app imports these as `__cm_window_*`.
//
// All ops post a UserEvent::WindowOp (or sibling) so the main event
// loop, which owns the tao Window handle, applies the change on its
// own thread. Sync ops that need a return value (is_maximized, etc.)
// query a shared state slot that the main loop keeps up to date.

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::sync::{Mutex, OnceLock};
use tao::event_loop::EventLoopProxy;

use carbon_runtime_contract::{UserEvent, WindowOp};

// ── Shared state — mirrored from the event loop ──────────────────────────
//
// The main loop updates these on every relevant WindowEvent so JS-side
// queries (`isMaximized()`, etc.) resolve synchronously without blocking
// on a round trip through the event loop.

static IS_MAXIMIZED: OnceLock<Mutex<bool>> = OnceLock::new();
static IS_MINIMIZED: OnceLock<Mutex<bool>> = OnceLock::new();
static IS_FOCUSED: OnceLock<Mutex<bool>> = OnceLock::new();
static INNER_SIZE: OnceLock<Mutex<(u32, u32)>> = OnceLock::new();
static SCALE_FACTOR: OnceLock<Mutex<f64>> = OnceLock::new();
// Identity of this process's window — "main" for the primary process,
// whatever the parent passed via `__cm_window_open("settings", …)` for
// children. Read at startup from --window-label / --window-opts CLI
// flags; JS reads them back via __cm_window_label() / __cm_window_opts_json().
static WINDOW_LABEL: OnceLock<Mutex<String>> = OnceLock::new();
static WINDOW_OPTS_JSON: OnceLock<Mutex<String>> = OnceLock::new();

fn flag(slot: &'static OnceLock<Mutex<bool>>) -> &'static Mutex<bool> {
    slot.get_or_init(|| Mutex::new(false))
}

pub fn set_is_maximized(v: bool) {
    *flag(&IS_MAXIMIZED)
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = v;
}
pub fn set_is_minimized(v: bool) {
    *flag(&IS_MINIMIZED)
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = v;
}
pub fn set_is_focused(v: bool) {
    *flag(&IS_FOCUSED).lock().unwrap_or_else(|e| e.into_inner()) = v;
}

/// Mirror the current physical inner size of the window so JS-side
/// `__cm_window_inner_size()` resolves without blocking on the event
/// loop. Called from main.rs on every Resized event AND once at startup.
pub fn set_inner_size(w: u32, h: u32) {
    let slot = INNER_SIZE.get_or_init(|| Mutex::new((0, 0)));
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = (w, h);
}

/// Mirror the current HiDPI scale factor. JS divides physical pixels by
/// this to get logical (CSS) pixels for `window.innerWidth/Height`.
pub fn set_scale_factor(s: f64) {
    let slot = SCALE_FACTOR.get_or_init(|| Mutex::new(1.0));
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = s;
}

fn current_size() -> (u32, u32) {
    *INNER_SIZE
        .get_or_init(|| Mutex::new((0, 0)))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn current_scale() -> f64 {
    *SCALE_FACTOR
        .get_or_init(|| Mutex::new(1.0))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn set_window_label(label: String) {
    *WINDOW_LABEL
        .get_or_init(|| Mutex::new(String::from("main")))
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = label;
}

pub fn set_window_opts_json(opts: String) {
    *WINDOW_OPTS_JSON
        .get_or_init(|| Mutex::new(String::from("{}")))
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = opts;
}

pub fn window_label() -> String {
    WINDOW_LABEL
        .get_or_init(|| Mutex::new(String::from("main")))
        .lock()
        .unwrap()
        .clone()
}

pub fn window_opts_json() -> String {
    WINDOW_OPTS_JSON
        .get_or_init(|| Mutex::new(String::from("{}")))
        .lock()
        .unwrap()
        .clone()
}

// ── Event loop proxy slot ───────────────────────────────────────────────

fn proxy_slot() -> &'static Mutex<Option<EventLoopProxy<UserEvent>>> {
    static P: OnceLock<Mutex<Option<EventLoopProxy<UserEvent>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

pub fn set_proxy(proxy: EventLoopProxy<UserEvent>) {
    *proxy_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(proxy);
}

fn post(ev: UserEvent) {
    if let Some(p) = proxy_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = p.send_event(ev);
    }
}

// ── Resize listeners ────────────────────────────────────────────────────
//
// JS callbacks registered by `__cm_window_register_resize_listener`. The
// event loop calls `dispatch_resize` after every WindowEvent::Resized so
// React components (e.g. WindowControls' onResized) re-query
// is_maximized / dimensions in response.

static RESIZE_LISTENER_TICK: OnceLock<Mutex<u32>> = OnceLock::new();

fn resize_tick() -> &'static Mutex<u32> {
    RESIZE_LISTENER_TICK.get_or_init(|| Mutex::new(0))
}

/// Called from main loop on WindowEvent::Resized. Bumps a counter the
/// JS side polls (or reacts to via the resize-listener eval below).
pub fn bump_resize_tick() {
    let mut t = resize_tick().lock().unwrap_or_else(|e| e.into_inner());
    *t = t.wrapping_add(1);
}

// ── Registration ─────────────────────────────────────────────────────────

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        // ── Fire-and-forget ops ─────────────────────────────────────────
        g.set(
            "__cm_window_show",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Show));
            })?,
        )?;
        g.set(
            "__cm_window_hide",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Hide));
            })?,
        )?;
        g.set(
            "__cm_window_minimize",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Minimize));
            })?,
        )?;
        g.set(
            "__cm_window_maximize",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Maximize));
            })?,
        )?;
        g.set(
            "__cm_window_unmaximize",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Unmaximize));
            })?,
        )?;
        g.set(
            "__cm_window_toggle_maximize",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::ToggleMaximize));
            })?,
        )?;
        g.set(
            "__cm_window_close",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Close));
            })?,
        )?;
        g.set(
            "__cm_window_focus",
            Function::new(ctx.clone(), || {
                post(UserEvent::WindowOp(WindowOp::Focus));
            })?,
        )?;
        g.set(
            "__cm_window_set_title",
            Function::new(ctx.clone(), |title: String| {
                post(UserEvent::WindowSetTitle(title));
            })?,
        )?;
        g.set(
            "__cm_window_set_fullscreen",
            Function::new(ctx.clone(), |on: bool| {
                post(UserEvent::WindowSetFullscreen(on));
            })?,
        )?;
        g.set(
            "__cm_window_start_drag",
            Function::new(ctx.clone(), || {
                // Posts a request to the main loop to call window.drag_window().
                // tao's API only supports this from the event-loop thread.
                post(UserEvent::WindowStartDrag);
            })?,
        )?;

        // ── Sync state queries (mirror updated by the event loop) ───────
        g.set(
            "__cm_window_is_maximized",
            Function::new(ctx.clone(), || -> bool {
                *flag(&IS_MAXIMIZED)
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
            })?,
        )?;
        g.set(
            "__cm_window_is_minimized",
            Function::new(ctx.clone(), || -> bool {
                *flag(&IS_MINIMIZED)
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
            })?,
        )?;
        g.set(
            "__cm_window_is_focused",
            Function::new(ctx.clone(), || -> bool {
                *flag(&IS_FOCUSED).lock().unwrap_or_else(|e| e.into_inner())
            })?,
        )?;

        // ── Resize-tick query ───────────────────────────────────────────
        // The JS wrapper subscribes by polling this counter or by
        // hooking the __cm_window_dispatch_resize global (called from
        // the event loop after each Resized).
        g.set(
            "__cm_window_resize_tick",
            Function::new(ctx.clone(), || -> u32 {
                *resize_tick().lock().unwrap_or_else(|e| e.into_inner())
            })?,
        )?;

        // ── Logical inner size (CSS pixels) ────────────────────────────
        // Returns the current viewport size in CSS pixels — what JS
        // libraries expect from `window.innerWidth/innerHeight`.
        // Physical pixels (`current_size`) are divided by the HiDPI
        // scale factor so high-DPI screens don't double the reported
        // size. The dom-shim wires `window.innerWidth/innerHeight` and
        // `document.documentElement.clientWidth/Height` to these.
        g.set(
            "__cm_window_inner_width",
            Function::new(ctx.clone(), || -> u32 {
                let (w, _) = current_size();
                let s = current_scale();
                if s > 0.0 {
                    (w as f64 / s).round() as u32
                } else {
                    w
                }
            })?,
        )?;
        g.set(
            "__cm_window_inner_height",
            Function::new(ctx.clone(), || -> u32 {
                let (_, h) = current_size();
                let s = current_scale();
                if s > 0.0 {
                    (h as f64 / s).round() as u32
                } else {
                    h
                }
            })?,
        )?;
        g.set(
            "__cm_window_device_pixel_ratio",
            Function::new(ctx.clone(), || -> f64 { current_scale() })?,
        )?;

        // ── Identity (process-per-window multi-window v1) ──────────────
        // `__cm_window_label()` returns "main" in the primary process,
        // or whatever label the parent process passed via
        // __cm_window_open("settings", …) for child processes.
        // The app's bundle reads this to decide which page to render.
        g.set(
            "__cm_window_label",
            Function::new(ctx.clone(), || -> String { window_label() })?,
        )?;
        g.set(
            "__cm_window_opts_json",
            Function::new(ctx.clone(), || -> String { window_opts_json() })?,
        )?;

        // ── Open a new window — spawns a child carbon-mini process ────
        // The child runs the SAME bundle as the parent (no per-window
        // build artifacts; bundles stay one file). The child reads
        // its label via __cm_window_label() and renders accordingly.
        //
        // We forward our argv except for any existing --window-label /
        // --window-opts flags (so the child gets fresh ones) and add the
        // new label + opts.
        //
        // The call returns null on success — actual window-open feedback
        // happens through process spawn (errors surface on next OS API
        // call). For richer feedback the parent can listen for an
        // app-defined event the child emits on mount.
        g.set(
            "__cm_window_open",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, label: String, opts_json: String| -> rquickjs::Result<()> {
                    let exe = match std::env::current_exe() {
                        Ok(p) => p,
                        Err(e) => return Err(Exception::throw_message(&ctx, &e.to_string())),
                    };
                    // Forward original argv, stripping --window-label /
                    // --window-opts pairs so we don't double-set them.
                    let mut argv: Vec<String> = std::env::args().skip(1).collect();
                    let mut filtered: Vec<String> = Vec::with_capacity(argv.len());
                    let mut iter = argv.drain(..);
                    while let Some(a) = iter.next() {
                        if a == "--window-label" || a == "--window-opts" {
                            let _ = iter.next(); // skip its value
                            continue;
                        }
                        filtered.push(a);
                    }
                    let mut cmd = std::process::Command::new(&exe);
                    cmd.args(&filtered);
                    cmd.arg("--window-label").arg(&label);
                    cmd.arg("--window-opts").arg(&opts_json);
                    match cmd.spawn() {
                        Ok(_) => Ok(()),
                        Err(e) => Err(Exception::throw_message(&ctx, &e.to_string())),
                    }
                },
            )?,
        )?;

        Ok(())
    })?;
    Ok(())
}
