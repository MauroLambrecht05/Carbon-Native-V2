// "Run this app at boot" wiring. auto-launch handles the per-platform
// shenanigans:
//   - Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run registry entry
//   - macOS:   ~/Library/LaunchAgents/<bundle>.plist
//   - Linux:   ~/.config/autostart/<app>.desktop
//
// The app identity comes from the current executable's path + a stable
// name derived from the executable's file stem. Apps that want a
// custom name pass it via __cm_autostart_set_name BEFORE enabling.

use anyhow::Result;
use auto_launch::AutoLaunch;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::sync::{Mutex, OnceLock};

fn cfg() -> &'static Mutex<(String, Vec<String>)> {
    // (app_name, extra_args). app_name defaults to the executable's
    // file stem so generic apps don't need any setup.
    static C: OnceLock<Mutex<(String, Vec<String>)>> = OnceLock::new();
    C.get_or_init(|| {
        let name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "carbon-mini-app".to_string());
        Mutex::new((name, Vec::new()))
    })
}

fn build() -> Option<AutoLaunch> {
    let exe = std::env::current_exe().ok()?;
    let exe_path = exe.to_str()?.to_string();
    let guard = cfg().lock().unwrap_or_else(|e| e.into_inner());
    let args: Vec<&str> = guard.1.iter().map(|s| s.as_str()).collect();
    // macOS's AutoLaunch::new takes a fourth `use_launch_agent: bool` other
    // platforms don't: true writes a LaunchAgent plist
    // (~/Library/LaunchAgents/<bundle>.plist, this file's own doc comment
    // above already promises that path), false drives it via AppleScript
    // instead. #[cfg] rather than a shared call: the other platforms'
    // `new` doesn't take this parameter at all, not merely default it.
    #[cfg(target_os = "macos")]
    {
        Some(AutoLaunch::new(&guard.0, &exe_path, true, &args))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(AutoLaunch::new(&guard.0, &exe_path, &args))
    }
}

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set(
            "__cm_autostart_set_name",
            Function::new(ctx.clone(), |name: String| {
                let mut guard = cfg().lock().unwrap_or_else(|e| e.into_inner());
                guard.0 = name;
            })?,
        )?;

        // args_json: a JSON-encoded array of strings; the args the OS
        // should pass to the binary on autostart. Useful for "open
        // minimized" or per-instance hints.
        g.set(
            "__cm_autostart_set_args",
            Function::new(ctx.clone(), |args_json: String| {
                let mut guard = cfg().lock().unwrap_or_else(|e| e.into_inner());
                guard.1 = serde_json::from_str(&args_json).unwrap_or_default();
            })?,
        )?;

        g.set(
            "__cm_autostart_enable",
            Function::new(ctx.clone(), |ctx: Ctx<'_>| -> rquickjs::Result<()> {
                let a = build().ok_or_else(|| throw(&ctx, "no current_exe"))?;
                a.enable().map_err(|e| throw(&ctx, e))
            })?,
        )?;

        g.set(
            "__cm_autostart_disable",
            Function::new(ctx.clone(), |ctx: Ctx<'_>| -> rquickjs::Result<()> {
                let a = build().ok_or_else(|| throw(&ctx, "no current_exe"))?;
                a.disable().map_err(|e| throw(&ctx, e))
            })?,
        )?;

        g.set(
            "__cm_autostart_is_enabled",
            Function::new(ctx.clone(), || -> bool {
                build().and_then(|a| a.is_enabled().ok()).unwrap_or(false)
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}
