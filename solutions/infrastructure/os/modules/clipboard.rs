// JS-side clipboard API. The runtime already uses arboard internally
// for the <input>/<textarea> Ctrl+C/V/X path; this just exposes the
// same handle to user JS so apps can read/write the OS clipboard
// outside a focused input.
//
// We keep the clipboard handle in a global once-lock — arboard
// constructs an X11/Wayland/NSPasteboard/Win32-clipboard handle on
// first use; subsequent calls reuse it.

use anyhow::Result;
use arboard::Clipboard;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::sync::{Mutex, OnceLock};

fn clipboard() -> &'static Mutex<Option<Clipboard>> {
    static C: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Clipboard::new().ok()))
}

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set("__cm_clipboard_read_text", Function::new(ctx.clone(), |ctx: Ctx<'_>| -> rquickjs::Result<String> {
            let mut guard = clipboard().lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_mut() {
                Some(c) => c.get_text().map_err(|e| throw(&ctx, e)),
                None => Ok(String::new()),
            }
        })?)?;

        g.set("__cm_clipboard_write_text", Function::new(ctx.clone(), |ctx: Ctx<'_>, text: String| -> rquickjs::Result<()> {
            let mut guard = clipboard().lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_mut() {
                Some(c) => c.set_text(text).map_err(|e| throw(&ctx, e)),
                None => Ok(()),
            }
        })?)?;

        // Convenience: clear the clipboard. arboard doesn't expose a
        // dedicated clear() — setting empty text is the same observable
        // behavior for our needs.
        g.set("__cm_clipboard_clear", Function::new(ctx.clone(), || -> () {
            let mut guard = clipboard().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(c) = guard.as_mut() {
                let _ = c.set_text(String::new());
            }
        })?)?;

        Ok(())
    })?;
    Ok(())
}
