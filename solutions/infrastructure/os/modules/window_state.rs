// Persist window position + size + maximized state across launches.
// Saves to a small JSON file at <config_dir>/<app_name>/window-state.json.
//
// Design intentionally simple: the JS side passes the state as a JSON
// string on save; load returns that string back (or null). The runtime
// doesn't interpret the fields — that's the app's job — so the same
// host imports work for whatever fields the app wants to remember
// (multi-monitor offsets, full-screen flag, sidebar widths, etc.).

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn app_name() -> &'static Mutex<String> {
    static N: OnceLock<Mutex<String>> = OnceLock::new();
    N.get_or_init(|| {
        let name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "carbon-mini-app".to_string());
        Mutex::new(name)
    })
}

fn state_path() -> Option<PathBuf> {
    let name = app_name().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut p = dirs::config_dir()?;
    p.push(&name);
    let _ = std::fs::create_dir_all(&p);
    p.push("window-state.json");
    Some(p)
}

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        // Override the app name (defaults to the binary's file stem).
        // Apps that ship under a custom name should call this once at
        // startup so the state file lands in the expected folder.
        g.set("__cm_window_state_set_app_name", Function::new(ctx.clone(), |name: String| -> () {
            let mut g = app_name().lock().unwrap_or_else(|e| e.into_inner());
            *g = name;
        })?)?;

        g.set("__cm_window_state_save", Function::new(ctx.clone(), |ctx: Ctx<'_>, json: String| -> rquickjs::Result<()> {
            let p = state_path().ok_or_else(|| throw(&ctx, "no config_dir"))?;
            std::fs::write(&p, json).map_err(|e| throw(&ctx, e))
        })?)?;

        // Returns the saved JSON string, or null if no state has been
        // persisted yet.
        g.set("__cm_window_state_load", Function::new(ctx.clone(), || -> Option<String> {
            let p = state_path()?;
            std::fs::read_to_string(&p).ok()
        })?)?;

        g.set("__cm_window_state_clear", Function::new(ctx.clone(), || -> () {
            if let Some(p) = state_path() {
                let _ = std::fs::remove_file(&p);
            }
        })?)?;

        Ok(())
    })?;
    Ok(())
}
