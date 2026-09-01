// Generic command-invocation channel. Mirrors Tauri's `invoke(name,
// args)` pattern so apps coming from Tauri can keep their command
// shape (`invoke('fs:read_file', { path })`) and only swap out the
// transport layer. Differences from real Tauri:
//
//   - In-process. There's no webview-to-host IPC; calls hit the JS
//     thread's handler directly, return a value, and the JS wrapper
//     stuffs it into a resolved Promise for API parity.
//   - Synchronous handlers. Long-running work should already use
//     `__cm_pty_*` / `__cm_proc_*` or a fetch-style streaming pattern.
//     The invoke channel is for fast OS queries (homedir, platform,
//     show-open-dialog) — anything that completes in well under a
//     frame.
//
// Registering a command:
//   The runtime registers built-ins in `register_builtins()`. Plugins
//   can drop additional handlers via `set_handler(name, closure)`.
//   Names are namespaced by convention with `:` (e.g. `fs:read_file`).

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::event_proxy::post;
use carbon_runtime_contract::{UserEvent, WindowOp};

// Handlers are stored behind `Arc` (not a bare `Box`) so `__cm_invoke` can
// clone the Arc out *under the lock* and call it after releasing the lock —
// without ever handing out a raw pointer into the HashMap. The previous
// implementation took a `*const Handler` and deref'd it after unlocking; a
// concurrent `set_handler` (plugins register at runtime) could reallocate the
// map's buckets and invalidate that pointer mid-call — a use-after-free. The
// Arc keeps the handler alive for the duration of the call regardless of what
// happens to the map.
type Handler = Arc<dyn Fn(&Value) -> Result<Value, String> + Send + Sync>;

fn registry() -> &'static Mutex<HashMap<String, Handler>> {
    static R: OnceLock<Mutex<HashMap<String, Handler>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register (or replace) a command handler. Thread-safe; can be called
/// from plugin init or any setup pass before the bundle eval'd.
pub fn set_handler<F>(name: &str, handler: F)
where
    F: Fn(&Value) -> Result<Value, String> + Send + Sync + 'static,
{
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(name.to_string(), Arc::new(handler));
}

/// Throw a real JS Error with `e`'s message, instead of misusing
/// rquickjs's FromJs-conversion-diagnostic constructor (see fs.rs's
/// `throw` doc comment for why that produced garbled messages).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    // Built-in commands.
    register_builtins();

    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        // __cm_invoke(name, argsJson) → resultJson (or throws).
        // The JS-side shim wraps this in a Promise so callers can
        // `await invoke('foo', {...})` like in Tauri. Errors are
        // thrown as native JS Error objects.
        g.set(
            "__cm_invoke",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, name: String, args_json: String| -> rquickjs::Result<String> {
                    let args: Value = if args_json.is_empty() {
                        Value::Null
                    } else {
                        serde_json::from_str(&args_json).map_err(|e| throw(&ctx, e))?
                    };
                    // Clone the Arc out under the lock, then release the lock
                    // before calling — the handler stays alive via the Arc no
                    // matter what happens to the map, and long-running handlers
                    // don't hold the registry lock while they run.
                    let handler = {
                        let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                        reg.get(&name).cloned()
                    };
                    let Some(handler) = handler else {
                        return Err(throw(&ctx, format!("invoke: unknown command '{name}'")));
                    };
                    let result = handler(&args);
                    match result {
                        Ok(v) => Ok(v.to_string()),
                        Err(msg) => Err(throw(&ctx, msg)),
                    }
                },
            )?,
        )?;

        // __cm_invoke_register(name) — does NOT define a handler
        // (those have to come from Rust); just lets JS query whether
        // a command is registered. Useful for graceful-fallback paths.
        g.set(
            "__cm_invoke_has",
            Function::new(ctx.clone(), |name: String| -> bool {
                registry()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains_key(&name)
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}

/// Built-in commands. Add small, always-on capabilities here.
/// Plugin-specific commands should register via `set_handler` during
/// their own init pass.
fn register_builtins() {
    set_handler("app:version", |_args| {
        Ok(Value::String(env!("CARGO_PKG_VERSION").to_string()))
    });
    set_handler("app:name", |_args| {
        Ok(Value::String("carbon-mini".to_string()))
    });
    set_handler("app:exit", |args| {
        let code = args.get("code").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        // Plugins that need cleanup will miss this — for now, this is
        // an emergency-exit. Apps should prefer triggering the regular
        // close path (window close button or `app.close()` via the
        // wm). Documented limitation; a future hook integration can
        // route through the plugin shutdown sequence.
        std::process::exit(code);
    });

    // ── Window control ─────────────────────────────────────────────────
    // The handlers POST a UserEvent so the main loop (which owns the
    // tao Window handle) can apply the change on its own thread. They
    // resolve as `null` from JS — Tauri's API is fire-and-forget too.
    fn op(op: WindowOp) -> Result<Value, String> {
        post(UserEvent::WindowOp(op));
        Ok(Value::Null)
    }
    set_handler("window:show", |_| op(WindowOp::Show));
    set_handler("window:hide", |_| op(WindowOp::Hide));
    set_handler("window:minimize", |_| op(WindowOp::Minimize));
    set_handler("window:maximize", |_| op(WindowOp::Maximize));
    set_handler("window:unmaximize", |_| op(WindowOp::Unmaximize));
    set_handler("window:toggle_maximize", |_| op(WindowOp::ToggleMaximize));
    set_handler("window:restore", |_| op(WindowOp::Restore));
    set_handler("window:close", |_| op(WindowOp::Close));
    set_handler("window:focus", |_| op(WindowOp::Focus));

    set_handler("window:set_title", |args| {
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        post(UserEvent::WindowSetTitle(title));
        Ok(Value::Null)
    });
    set_handler("window:set_fullscreen", |args| {
        let on = args
            .get("fullscreen")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        post(UserEvent::WindowSetFullscreen(on));
        Ok(Value::Null)
    });

    // ── Tauri-compat commands used by ported apps ─────────────────────────
    // These mirror the `invoke('fs_read_dir', { path })` shape Tauri apps
    // use so existing React/Vue code paths work without rewriting every
    // call site. Names are unsnake'd from the Tauri originals.

    set_handler("fs_read_dir", |args| {
        use std::fs;
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return Err("fs_read_dir: missing path".into());
        }
        let show_hidden = args
            .get("showHidden")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let it = fs::read_dir(path).map_err(|e| e.to_string())?;
        let mut out: Vec<Value> = Vec::new();
        for entry in it.flatten() {
            let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            // Skip dotfiles unless showHidden is set. Windows hidden-attribute
            // detection (the more correct behavior on this OS) would need
            // FILE_ATTRIBUTE_HIDDEN — for parity with the Tauri impl, dot-prefix
            // is good enough for the file tree's first cut.
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let kind = if meta.file_type().is_symlink() {
                "symlink"
            } else if meta.is_dir() {
                "dir"
            } else {
                "file"
            };
            let size = if meta.is_file() { meta.len() } else { 0 };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let mut obj = serde_json::Map::new();
            obj.insert("name".into(), Value::String(name));
            obj.insert("kind".into(), Value::String(kind.into()));
            obj.insert("size".into(), Value::Number(size.into()));
            obj.insert("mtime".into(), Value::Number(mtime.into()));
            out.push(Value::Object(obj));
        }
        // Directories first, then files, both alphabetical — matches what
        // most file explorers do.
        out.sort_by(|a, b| {
            let ak = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let bk = b.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
            match (ak, bk) {
                ("dir", "file") | ("dir", "symlink") => std::cmp::Ordering::Less,
                ("file", "dir") | ("symlink", "dir") => std::cmp::Ordering::Greater,
                _ => an.to_lowercase().cmp(&bn.to_lowercase()),
            }
        });
        Ok(Value::Array(out))
    });

    // Read a file, discriminating text/binary/too-large the way the
    // frontend's `ReadResult` union expects:
    //   { kind: "text", content, size } | { kind: "binary", size }
    //   | { kind: "toolarge", size, limit }
    // A bare string here (the previous shape) leaves `res.kind`
    // `undefined` on the JS side, so callers like useDocument.ts never
    // match any branch and get stuck at their initial "loading" state
    // forever — this exact bug was hit end-to-end against terax-ai.
    set_handler("fs_read_file", |args| {
        use std::fs;
        const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
        const BINARY_SNIFF_BYTES: usize = 8 * 1024;
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return Err("fs_read_file: missing path".into());
        }

        let meta = fs::metadata(path).map_err(|e| e.to_string())?;
        let size = meta.len();
        if size > MAX_READ_BYTES {
            let mut obj = serde_json::Map::new();
            obj.insert("kind".into(), Value::String("toolarge".into()));
            obj.insert("size".into(), Value::Number(size.into()));
            obj.insert("limit".into(), Value::Number(MAX_READ_BYTES.into()));
            return Ok(Value::Object(obj));
        }

        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        // Null-byte sniff on the first chunk — cheap heuristic that
        // catches the common "this is actually a PNG" case before
        // paying for a full UTF-8 validation pass.
        let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
        let looks_binary = bytes[..sniff_len].contains(&0);

        let mut obj = serde_json::Map::new();
        if !looks_binary {
            if let Ok(content) = String::from_utf8(bytes) {
                obj.insert("kind".into(), Value::String("text".into()));
                obj.insert("content".into(), Value::String(content));
                obj.insert("size".into(), Value::Number(size.into()));
                return Ok(Value::Object(obj));
            }
        }
        obj.insert("kind".into(), Value::String("binary".into()));
        obj.insert("size".into(), Value::Number(size.into()));
        Ok(Value::Object(obj))
    });

    set_handler("fs_create_file", |args| {
        use std::fs;
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return Err("fs_create_file: missing path".into());
        }
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = fs::create_dir_all(parent);
            }
        }
        fs::write(path, "").map_err(|e| e.to_string())?;
        Ok(Value::Null)
    });

    set_handler("fs_write_file", |args| {
        use std::fs;
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        // The frontend (useDocument.ts) sends `content`; older Tauri call
        // sites used `contents`. Accept either so Save doesn't silently
        // write an empty file when the key doesn't match.
        let contents = args
            .get("content")
            .or_else(|| args.get("contents"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if path.is_empty() {
            return Err("fs_write_file: missing path".into());
        }
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = fs::create_dir_all(parent);
            }
        }
        fs::write(path, contents).map_err(|e| e.to_string())?;
        Ok(Value::Null)
    });

    set_handler("fs_rename", |args| {
        let from = args.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("");
        if from.is_empty() || to.is_empty() {
            return Err("fs_rename: missing from/to".into());
        }
        std::fs::rename(from, to).map_err(|e| e.to_string())?;
        Ok(Value::Null)
    });

    set_handler("fs_delete", |args| {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return Err("fs_delete: missing path".into());
        }
        let p = std::path::Path::new(path);
        if p.is_dir() {
            std::fs::remove_dir_all(p).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
        Ok(Value::Null)
    });

    // ── Secrets — wired to the OS keychain via the `keyring` crate ──────
    // Tauri's plugin-store has its own secrets API; ports of Tauri apps
    // call these four commands. Args follow Tauri's shape:
    //   secrets_get      ({ service, account }) -> string | null
    //   secrets_set      ({ service, account, password }) -> null
    //   secrets_delete   ({ service, account }) -> null
    //   secrets_get_all  ({ service, accounts: string[] }) -> (string | null)[]
    //
    // Backed by the same `keyring::Entry` API the `__cm_keychain_*` host
    // imports use directly — Windows Credential Manager, macOS Keychain,
    // Linux Secret Service. A missing entry resolves as null (not an
    // error) so callers don't have to wrap every read in try/catch.
    fn keyring_get(service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    set_handler("secrets_get", |args| {
        let service = args.get("service").and_then(|v| v.as_str()).unwrap_or("");
        let account = args.get("account").and_then(|v| v.as_str()).unwrap_or("");
        match keyring_get(service, account)? {
            Some(s) => Ok(Value::String(s)),
            None => Ok(Value::Null),
        }
    });
    set_handler("secrets_get_all", |args| {
        let service = args.get("service").and_then(|v| v.as_str()).unwrap_or("");
        let accounts = args
            .get("accounts")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out: Vec<Value> = Vec::with_capacity(accounts.len());
        for acc in accounts {
            let account = acc.as_str().unwrap_or("");
            match keyring_get(service, account)? {
                Some(s) => out.push(Value::String(s)),
                None => out.push(Value::Null),
            }
        }
        Ok(Value::Array(out))
    });
    set_handler("secrets_set", |args| {
        let service = args.get("service").and_then(|v| v.as_str()).unwrap_or("");
        let account = args.get("account").and_then(|v| v.as_str()).unwrap_or("");
        let password = args.get("password").and_then(|v| v.as_str()).unwrap_or("");
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        entry.set_password(password).map_err(|e| e.to_string())?;
        Ok(Value::Null)
    });
    set_handler("secrets_delete", |args| {
        let service = args.get("service").and_then(|v| v.as_str()).unwrap_or("");
        let account = args.get("account").and_then(|v| v.as_str()).unwrap_or("");
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(e) => Err(e.to_string()),
        }
    });

    set_handler("wsl_list_distros", |_args| Ok(Value::Array(vec![])));
    set_handler("wsl_default_distro", |_args| Ok(Value::Null));
    set_handler("wsl_home", |_args| Ok(Value::Null));

    // lm_ping / ai_http_stream — reqwest-backed, only exist when the
    // `network` Cargo feature is on (default: on — see carbon-os/Cargo.toml
    // and lib.rs's register_network for what opting out actually drops).
    #[cfg(feature = "network")]
    {
        set_handler("lm_ping", crate::net::lm_ping);
        set_handler("ai_http_stream", crate::net::ai_http_stream_invoke);
    }

    // fs_grep/fs_glob/fs_search/list_subdirs moved out of the always-on
    // runtime and into the file-search plugin (products/carbon-sdk/
    // file-search) — see that plugin's own header for why: these pulled in
    // ~1.2 MiB of regex/glob/gitignore-walking crates unconditionally, for
    // a capability most apps never use. `carbon plugin add file-search`
    // opts an app back in.

    // ── Shell command execution / sessions / background procs ──────────
    // (see shell_exec.rs — distinct from the interactive PTY terminal)
    set_handler("shell_run_command", crate::shell_exec::shell_run_command);
    set_handler("shell_session_open", crate::shell_exec::shell_session_open);
    set_handler("shell_session_run", crate::shell_exec::shell_session_run);
    set_handler(
        "shell_session_close",
        crate::shell_exec::shell_session_close,
    );
    set_handler("shell_bg_spawn", crate::shell_exec::shell_bg_spawn);
    set_handler("shell_bg_logs", crate::shell_exec::shell_bg_logs);
    set_handler("shell_bg_kill", crate::shell_exec::shell_bg_kill);
    set_handler("shell_bg_list", crate::shell_exec::shell_bg_list);

    // Tauri plugin-store commands — return null/empty so the LazyStore
    // wrapper falls back to its defaults map without crashing on
    // `new Map(undefined)`/etc.
    set_handler("plugin:store|load", |_args| Ok(Value::Null));
    set_handler("plugin:store|get", |_args| Ok(Value::Null));
    set_handler("plugin:store|has", |_args| Ok(Value::Bool(false)));
    set_handler("plugin:store|set", |_args| Ok(Value::Null));
    set_handler("plugin:store|delete", |_args| Ok(Value::Bool(true)));
    set_handler("plugin:store|clear", |_args| Ok(Value::Null));
    set_handler("plugin:store|save", |_args| Ok(Value::Null));
    set_handler("plugin:store|reset", |_args| Ok(Value::Null));
    set_handler("plugin:store|keys", |_args| Ok(Value::Array(vec![])));
    set_handler("plugin:store|values", |_args| Ok(Value::Array(vec![])));
    set_handler("plugin:store|entries", |_args| Ok(Value::Array(vec![])));
    set_handler("plugin:store|length", |_args| Ok(Value::Number(0.into())));

    set_handler("open_settings_window", |_args| Ok(Value::Null));
}
