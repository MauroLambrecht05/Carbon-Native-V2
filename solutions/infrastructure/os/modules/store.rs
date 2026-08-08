// Persistent key-value store. Equivalent to Tauri's `plugin-store`:
// each store is a JSON file under the app's config directory, with a
// flat map of string keys to JSON values. Apps use it for things that
// should outlive the process but aren't worth a real database:
// preferences, recent-file lists, AI session history, theme choice.
//
// Storage model
// -------------
// One file per logical store. Files are kept under
// `<config_dir>/<app_id>/`. The app_id is derived from the project
// directory name when carbon.toml doesn't specify one — close enough
// for v1, and matches what `window_state.rs` does.
//
// In-memory cache + write-on-every-mutation. Reads are O(1); writes
// pay a JSON serialise + atomic file replace. For the ~1 KB stores
// most apps actually use, this is well under a millisecond. Apps with
// large stores can shard across multiple files.
//
// Concurrency: a single Mutex guards the cache + on-disk path. PTY /
// AI worker threads that mutate via the JS thread serialise naturally;
// direct Rust callers don't exist.

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

struct StoreState {
    cache: HashMap<String, Value>,
    /// Resolved absolute path to the JSON file. Lazy on first use.
    path: PathBuf,
    /// Set to true after a successful disk load — distinguishes
    /// "didn't load yet" from "loaded and key missing".
    loaded: bool,
}

fn registry() -> &'static Mutex<HashMap<String, StoreState>> {
    static R: OnceLock<Mutex<HashMap<String, StoreState>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_id() -> String {
    // Match window_state.rs: derive from the current exe's parent
    // directory name. carbon.toml-driven ids are a future refinement.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|d| d.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "carbon-mini".to_string())
}

fn resolve_path(file: &str) -> Option<PathBuf> {
    let base = dirs::config_dir()?.join(app_id());
    let _ = std::fs::create_dir_all(&base);
    // Strip any leading separators the caller might have included so
    // we always anchor under the app config dir.
    let trimmed = file.trim_start_matches(|c: char| c == '/' || c == '\\');
    if trimmed.is_empty() { return None; }
    Some(base.join(trimmed))
}

fn ensure_loaded(file: &str) -> Option<()> {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if reg.contains_key(file) {
        return Some(());
    }
    let path = resolve_path(file)?;
    let mut state = StoreState {
        cache: HashMap::new(),
        path,
        loaded: false,
    };
    if let Ok(bytes) = std::fs::read(&state.path) {
        if let Ok(map) = serde_json::from_slice::<HashMap<String, Value>>(&bytes) {
            state.cache = map;
        }
    }
    state.loaded = true;
    reg.insert(file.to_string(), state);
    Some(())
}

fn persist(state: &StoreState) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(&state.cache).unwrap_or_else(|_| b"{}".to_vec());
    // Atomic-ish write: write to a sibling tmp file, then rename. On
    // Windows the rename is non-atomic across drives but the file is
    // always in app-config so this is fine.
    let tmp = state.path.with_extension("tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &state.path)
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
            "__cm_store_get",
            Function::new(ctx.clone(), |file: String, key: String| -> String {
                ensure_loaded(&file);
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                match reg.get(&file).and_then(|s| s.cache.get(&key)) {
                    Some(v) => v.to_string(),
                    None => "null".to_string(),
                }
            })?,
        )?;

        g.set(
            "__cm_store_set",
            Function::new(ctx.clone(), |ctx: Ctx<'_>, file: String, key: String, value_json: String| -> rquickjs::Result<()> {
                ensure_loaded(&file);
                let v: Value = serde_json::from_str(&value_json).map_err(|e| throw(&ctx, e))?;
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = reg.get_mut(&file) {
                    state.cache.insert(key, v);
                    if let Err(e) = persist(state) {
                        return Err(throw(&ctx, e));
                    }
                }
                Ok(())
            })?,
        )?;

        g.set(
            "__cm_store_delete",
            Function::new(ctx.clone(), |ctx: Ctx<'_>, file: String, key: String| -> rquickjs::Result<bool> {
                ensure_loaded(&file);
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                let Some(state) = reg.get_mut(&file) else { return Ok(false); };
                let existed = state.cache.remove(&key).is_some();
                if existed {
                    if let Err(e) = persist(state) {
                        return Err(throw(&ctx, e));
                    }
                }
                Ok(existed)
            })?,
        )?;

        g.set(
            "__cm_store_has",
            Function::new(ctx.clone(), |file: String, key: String| -> bool {
                ensure_loaded(&file);
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                reg.get(&file).map(|s| s.cache.contains_key(&key)).unwrap_or(false)
            })?,
        )?;

        g.set(
            "__cm_store_keys",
            Function::new(ctx.clone(), |file: String| -> String {
                ensure_loaded(&file);
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                let keys: Vec<&String> = reg
                    .get(&file)
                    .map(|s| s.cache.keys().collect())
                    .unwrap_or_default();
                serde_json::to_string(&keys).unwrap_or_else(|_| "[]".to_string())
            })?,
        )?;

        g.set(
            "__cm_store_entries",
            Function::new(ctx.clone(), |file: String| -> String {
                ensure_loaded(&file);
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                match reg.get(&file) {
                    Some(s) => serde_json::to_string(&s.cache).unwrap_or_else(|_| "{}".into()),
                    None => "{}".into(),
                }
            })?,
        )?;

        g.set(
            "__cm_store_clear",
            Function::new(ctx.clone(), |ctx: Ctx<'_>, file: String| -> rquickjs::Result<()> {
                ensure_loaded(&file);
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = reg.get_mut(&file) {
                    state.cache.clear();
                    if let Err(e) = persist(state) {
                        return Err(throw(&ctx, e));
                    }
                }
                Ok(())
            })?,
        )?;

        // save(file) — explicit flush. Currently a no-op since every
        // mutation persists, but apps that switch to debounced writes
        // can call this to force a flush before exit.
        g.set(
            "__cm_store_save",
            Function::new(ctx.clone(), |ctx: Ctx<'_>, file: String| -> rquickjs::Result<()> {
                ensure_loaded(&file);
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = reg.get(&file) {
                    if let Err(e) = persist(state) {
                        return Err(throw(&ctx, e));
                    }
                }
                Ok(())
            })?,
        )?;

        // reload(file) — drop the cache and re-read from disk. Useful
        // when an external process (or another app instance) wrote to
        // the file.
        g.set(
            "__cm_store_reload",
            Function::new(ctx.clone(), |file: String| -> rquickjs::Result<()> {
                {
                    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                    reg.remove(&file);
                }
                ensure_loaded(&file);
                Ok(())
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}
