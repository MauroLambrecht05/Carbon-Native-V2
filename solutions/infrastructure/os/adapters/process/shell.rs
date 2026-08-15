// `shell.open(target)` — opens a URL or file path in the OS-default
// handler. Wraps `start` on Windows / `open` on macOS / `xdg-open` on
// Linux via the `opener` crate.
//
// `shell.reveal(path)` — opens the file's parent directory in the OS
// file manager with the file highlighted (Explorer / Finder /
// nautilus). Falls back to opening the parent without selection if
// the platform-specific reveal call fails.

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::path::Path;

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set(
            "__cm_shell_open",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, target: String| -> rquickjs::Result<()> {
                    opener::open(&target).map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        g.set(
            "__cm_shell_reveal",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String| -> rquickjs::Result<()> {
                    let p = Path::new(&path);
                    // `ctx` is only read on the Linux branch, which is the only
                    // one that can fail and therefore the only one that builds a
                    // throw. Windows and macOS delegate to an infallible
                    // platform call, so the parameter is genuinely unused there.
                    #[cfg(any(target_os = "windows", target_os = "macos"))]
                    let _ = &ctx;
                    #[cfg(target_os = "windows")]
                    {
                        carbon_platform::windows::reveal_in_file_manager(p);
                        Ok(())
                    }
                    #[cfg(target_os = "macos")]
                    {
                        carbon_platform::macos::reveal_in_file_manager(p);
                        return Ok(());
                    }
                    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
                    {
                        // Linux has no universal "reveal file" — best we can
                        // do is open the parent directory.
                        let parent = p.parent().unwrap_or(p);
                        opener::open(parent).map_err(|e| throw(&ctx, e))
                    }
                },
            )?,
        )?;

        // Returns the canonicalized absolute path or None if it can't
        // resolve (e.g. the path doesn't exist). Useful for normalizing
        // user input before handing to FS / shell ops.
        g.set(
            "__cm_shell_resolve",
            Function::new(ctx.clone(), |path: String| -> Option<String> {
                std::fs::canonicalize(&path)
                    .ok()
                    .and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}
