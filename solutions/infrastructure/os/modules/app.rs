// App metadata host imports — name and version read from carbon.toml's
// [app] table at startup, stashed in static slots so JS sync access is
// instant (no file read on every call).

use anyhow::Result;
use rquickjs::{Context as JsContext, Function};
use std::sync::{Mutex, OnceLock};

fn name_slot() -> &'static Mutex<String> {
    static S: OnceLock<Mutex<String>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(String::new()))
}

fn version_slot() -> &'static Mutex<String> {
    static S: OnceLock<Mutex<String>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(String::new()))
}

pub fn set_metadata(name: &str, version: &str) {
    *name_slot().lock().unwrap_or_else(|e| e.into_inner()) = name.to_string();
    *version_slot().lock().unwrap_or_else(|e| e.into_inner()) = version.to_string();
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();
        g.set("__cm_app_name", Function::new(ctx.clone(), || -> String {
            name_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()
        })?)?;
        g.set("__cm_app_version", Function::new(ctx.clone(), || -> String {
            version_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()
        })?)?;
        Ok(())
    })?;
    Ok(())
}
