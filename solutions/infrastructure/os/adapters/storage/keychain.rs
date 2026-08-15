// Native credential storage via the `keyring` crate. Wraps:
//   - Windows: Credential Manager (wincred)
//   - macOS:   Keychain Services (Security framework)
//   - Linux:   Secret Service (libsecret) — falls back to keyutils
//              if D-Bus isn't available.
//
// Storage is keyed by (service, account) — `service` is typically the
// app's reverse-DNS or human name; `account` is the user-scoped key
// (e.g. "openai-api-key", "anthropic-token"). Password is an arbitrary
// UTF-8 string; binary blobs should be base64-encoded by the caller.

use anyhow::Result;
use keyring::Entry;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set(
            "__cm_keychain_set",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>,
                 service: String,
                 account: String,
                 password: String|
                 -> rquickjs::Result<()> {
                    let entry = Entry::new(&service, &account).map_err(|e| throw(&ctx, e))?;
                    entry.set_password(&password).map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        // Returns null when the entry doesn't exist (rather than
        // throwing) — that's the common "haven't logged in yet" path
        // and shouldn't read as an error.
        g.set(
            "__cm_keychain_get",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>,
                 service: String,
                 account: String|
                 -> rquickjs::Result<Option<String>> {
                    let entry = Entry::new(&service, &account).map_err(|e| throw(&ctx, e))?;
                    match entry.get_password() {
                        Ok(s) => Ok(Some(s)),
                        Err(keyring::Error::NoEntry) => Ok(None),
                        Err(e) => Err(throw(&ctx, e)),
                    }
                },
            )?,
        )?;

        // Idempotent — deleting a missing entry is a no-op rather than
        // an error.
        g.set(
            "__cm_keychain_delete",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, service: String, account: String| -> rquickjs::Result<()> {
                    let entry = Entry::new(&service, &account).map_err(|e| throw(&ctx, e))?;
                    match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(e) => Err(throw(&ctx, e)),
                    }
                },
            )?,
        )?;

        Ok(())
    })?;
    Ok(())
}
