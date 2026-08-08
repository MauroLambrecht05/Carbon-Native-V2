// OS introspection host imports. Mirrors `tauri-plugin-os`: small,
// always-available queries about the host environment. Apps use these
// for cross-platform branching, telemetry, "What system am I running
// on" UI strings.
//
// Cheap: all values come from `std::env` / compile-time consts, with
// the exception of hostname which is one syscall. Cached after first
// read so repeated polls are free.

use anyhow::Result;
use rquickjs::{Context as JsContext, Function};
use std::sync::OnceLock;

fn platform_str() -> &'static str {
    if cfg!(target_os = "windows") { "windows" }
    else if cfg!(target_os = "macos") { "macos" }
    else if cfg!(target_os = "linux") { "linux" }
    else if cfg!(target_os = "freebsd") { "freebsd" }
    else if cfg!(target_os = "openbsd") { "openbsd" }
    else if cfg!(target_os = "netbsd") { "netbsd" }
    else if cfg!(target_os = "dragonfly") { "dragonfly" }
    else if cfg!(target_os = "android") { "android" }
    else if cfg!(target_os = "ios") { "ios" }
    else { "unknown" }
}

fn arch_str() -> &'static str {
    if cfg!(target_arch = "x86_64") { "x86_64" }
    else if cfg!(target_arch = "aarch64") { "aarch64" }
    else if cfg!(target_arch = "x86") { "x86" }
    else if cfg!(target_arch = "arm") { "arm" }
    else { "unknown" }
}

fn hostname_cached() -> String {
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| {
        // Cross-platform hostname via env vars — avoids pulling in
        // gethostname / libc bindings. The Tauri plugin uses the
        // `hostname` crate; for our purposes COMPUTERNAME (Windows)
        // and HOSTNAME (Unix) are fine.
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "unknown".to_string())
    })
    .clone()
}

fn os_version() -> String {
    // No portable way to get a meaningful version without a crate. We
    // expose a coarse identifier — apps that need a precise version
    // can shell out via __cm_proc_exec.
    if cfg!(target_os = "windows") {
        // Windows version constants — these compile in but say nothing
        // about the runtime kernel version. Return "windows" and let
        // apps that care call `ver` via __cm_proc_exec.
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        "unknown".to_string()
    }
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set(
            "__cm_os_platform",
            Function::new(ctx.clone(), || platform_str().to_string())?,
        )?;
        g.set(
            "__cm_os_arch",
            Function::new(ctx.clone(), || arch_str().to_string())?,
        )?;
        g.set(
            "__cm_os_version",
            Function::new(ctx.clone(), || os_version())?,
        )?;
        g.set(
            "__cm_os_hostname",
            Function::new(ctx.clone(), || hostname_cached())?,
        )?;
        g.set(
            "__cm_os_temp_dir",
            Function::new(ctx.clone(), || {
                std::env::temp_dir().to_string_lossy().to_string()
            })?,
        )?;
        g.set(
            "__cm_os_home_dir",
            Function::new(ctx.clone(), || {
                dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
            })?,
        )?;
        g.set(
            "__cm_os_locale",
            Function::new(ctx.clone(), || {
                // LANG / LC_ALL are the portable knobs. Windows uses
                // GetUserDefaultLocaleName but we'd need a winapi
                // binding for that; LANG is good enough.
                std::env::var("LANG")
                    .or_else(|_| std::env::var("LC_ALL"))
                    .or_else(|_| std::env::var("LC_MESSAGES"))
                    .unwrap_or_else(|_| "en-US".to_string())
            })?,
        )?;
        g.set(
            "__cm_os_eol",
            Function::new(ctx.clone(), || {
                if cfg!(target_os = "windows") { "\r\n" } else { "\n" }.to_string()
            })?,
        )?;
        g.set(
            "__cm_os_exe_path",
            Function::new(ctx.clone(), || {
                std::env::current_exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            })?,
        )?;
        // Tauri exposes `family` (unix | windows) — small but useful
        // for path-handling fast paths.
        g.set(
            "__cm_os_family",
            Function::new(ctx.clone(), || {
                if cfg!(target_family = "windows") { "windows" }
                else if cfg!(target_family = "unix") { "unix" }
                else { "unknown" }
                .to_string()
            })?,
        )?;
        // __cm_os_theme() → "light" | "dark". Read from a static slot
        // populated at window-build time by main.rs (tao exposes the
        // initial theme on the WindowBuilder; ThemeChanged events
        // update the slot). Falls back to "light" when unknown.
        g.set(
            "__cm_os_theme",
            Function::new(ctx.clone(), || crate::os_theme::current())?,
        )?;

        Ok(())
    })?;
    Ok(())
}
