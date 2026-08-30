// Native OS integration host imports.
//
// Each submodule wires a small slice of OS functionality into the JS
// context as `__cm_<feature>_*` functions. The companion TypeScript
// package `stdlib/api/` exposes a nicer Promise-or-sync API
// over those host imports.
//
// All ops are synchronous (no tokio runtime needed) — for long-running
// operations like child processes we use a handle pattern (spawn returns
// an id, separate read/write/wait/kill calls operate on that id).
//
// Mirrors Tauri's plugin organization (one module per concern) but
// without the dynamic-loading machinery — these are baked into the
// runtime binary because they're tiny (<300 KB total after LTO) and
// every productivity app needs at least some of them.

use anyhow::{anyhow, Result};
use rquickjs::Context as JsContext;
use tao::event_loop::EventLoopProxy;

use carbon_runtime_contract::UserEvent;

// ── Layout ──────────────────────────────────────────────────────────────────
// Nineteen driven adapters, grouped by what they actually touch rather than
// left as nineteen files in one directory. The groups answer "where does a new
// host function go" — a clipboard call is desktop, a PTY call is process — and
// they are the SAME eight names interface/stdlib/bindings uses on the
// JavaScript side, so a host function and its wrapper always sit in same-named
// directories on both sides of the boundary.
//
// `adapters/`, not `modules/`: every file under it is a driven adapter over
// one piece of the OS, which is what this tier is for. "modules" said only
// that they were Rust modules, which the `mod` keyword next to it already did.
#[path = "adapters/system/app.rs"]
pub mod app;
#[path = "adapters/system/autostart.rs"]
pub mod autostart;
#[path = "adapters/filesystem/fs.rs"]
pub mod fs;
#[path = "adapters/filesystem/fs_search.rs"]
pub mod fs_search;
#[path = "adapters/bridge/invoke.rs"]
pub mod invoke;
#[path = "adapters/system/log.rs"]
pub mod log;
#[path = "adapters/net/net.rs"]
pub mod net;
#[path = "adapters/system/os.rs"]
pub mod os;
#[path = "adapters/system/os_theme.rs"]
pub mod os_theme;
#[path = "adapters/process/process.rs"]
pub mod process;
#[path = "adapters/process/pty.rs"]
pub mod pty;
#[path = "adapters/process/shell.rs"]
pub mod shell;
#[path = "adapters/process/shell_exec.rs"]
pub mod shell_exec;
#[path = "adapters/storage/store.rs"]
pub mod store;
#[path = "adapters/window/window.rs"]
pub mod window;
#[path = "adapters/window/window_state.rs"]
pub mod window_state;

/// A startup-phase tracer, supplied by whoever is composing the runtime.
///
/// This is a port, and it is a port rather than a shared function because the
/// two backends genuinely disagree about what it does: mini emits a full trace
/// with per-phase deltas and is gated OUT by CARBON_NO_TIMING, while blitz
/// emits one line per phase and is gated IN by CARBON_MINI_TIMING. Sharing one
/// implementation would have to pick a winner and change one backend's
/// behaviour.
///
/// The phase names this receives are a contract in their own right — they are
/// the sequence pinned in .tools/validation/baselines/startup-phases.txt, and
/// the order they arrive in encodes the startup dependency graph.
pub type PhaseLogger<'a> = &'a dyn Fn(&str);

/// Register every native host import on the JS context. Called once at
/// startup, after `register_host_imports` so `console.log` etc. are
/// already in place for any startup error messages from these modules.
///
/// `tlog` receives one phase name per group of modules — see PhaseLogger.
///
/// `process_enabled` gates `__cm_proc_exec`/`__cm_proc_spawn` and friends —
/// see `products/carbon/composition/manifest.rs::read_process_enabled` for
/// why this has to be a startup-time registration decision rather than a
/// bundler-level import gate: a raw process-spawn primitive that's an
/// always-present `globalThis` property is reachable by name regardless of
/// what any import resolver allows, so the only real boundary is whether
/// the global was ever installed at all. The `native.process` phase marker
/// still fires either way, to keep the startup-phase sequence
/// (`.tools/validation/baselines/startup-phases.txt`) stable for apps that
/// don't opt in — only the registration itself is conditional.
pub fn register_all(
    js_ctx: &JsContext,
    proxy: EventLoopProxy<UserEvent>,
    tlog: PhaseLogger<'_>,
    process_enabled: bool,
) -> Result<()> {
    fs::register(js_ctx)?;
    tlog("native.fs");
    if process_enabled {
        process::register(js_ctx)?;
    }
    tlog("native.process");
    shell::register(js_ctx)?;
    autostart::register(js_ctx)?;
    window_state::register(js_ctx)?;
    tlog("native.shell_autostart_winstate");
    store::register(js_ctx)?;
    pty::register(js_ctx)?;
    tlog("native.store_pty");
    os::register(js_ctx)?;
    log::register(js_ctx)?;
    invoke::register(js_ctx)?;
    // Carbon-native window control. Stash the proxy so the host imports
    // can post window ops back to the event loop.
    window::set_proxy(proxy.clone());
    window::register(js_ctx)?;
    app::register(js_ctx)?;
    tlog("native.os_log_invoke_window_app");

    // Networking: cache the EventLoopProxy so tokio tasks can post
    // back, register host imports, then eval the JS shim that exposes
    // a Web-compatible `fetch` / `WebSocket` / `Response` / `Headers` /
    // `AbortController` over those host imports.
    net::set_proxy(proxy);
    net::register(js_ctx)?;
    tlog("native.net");
    static NET_SHIM: &str = include_str!("adapters/net/net_shim.js");
    js_ctx.with(|ctx| -> Result<()> {
        match ctx.eval::<(), _>(NET_SHIM.as_bytes()) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Extract the pending exception via raw FFI (safe on any
                // context, including snapshot-restored ones).
                let detail = unsafe {
                    use rquickjs::qjs;
                    let raw = ctx.as_raw().as_ptr();
                    let exc = qjs::JS_GetException(raw);
                    let cstr = qjs::JS_ToCString(raw, exc);
                    let s = if cstr.is_null() {
                        format!("{e}")
                    } else {
                        let m = std::ffi::CStr::from_ptr(cstr)
                            .to_string_lossy()
                            .into_owned();
                        qjs::JS_FreeCString(raw, cstr);
                        m
                    };
                    qjs::JS_FreeValue(raw, exc);
                    s
                };
                Err(anyhow!("net_shim eval: {detail}"))
            }
        }
    })?;
    Ok(())
}
