// System notifications via notify-rust. Toasts on Windows (WinRT-style
// via the notification crate's Win32 backend), banners on macOS
// (NSUserNotification), org.freedesktop.Notifications on Linux.
//
// Notifications fire-and-forget — the user dismisses them via the OS,
// not our app. We don't expose click callbacks for now (notify-rust
// supports them but requires keeping a tokio-style event loop alive
// for the notification's lifetime which doesn't compose well with
// our single-threaded paint loop).

use anyhow::Result;
use notify_rust::Notification;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        // title + body + optional icon path. Icon is a file path on
        // disk (or the empty string to use the system default icon).
        g.set(
            "__cm_notification_send",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, title: String, body: String, icon: String| -> rquickjs::Result<()> {
                    let mut n = Notification::new();
                    n.summary(&title).body(&body);
                    if !icon.is_empty() {
                        n.icon(&icon);
                    }
                    n.show().map(|_| ()).map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        Ok(())
    })?;
    Ok(())
}
