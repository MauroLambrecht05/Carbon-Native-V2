// File-system host imports. Mirrors the slice of `node:fs` and Tauri's
// `plugin-fs` that productivity apps actually need: read/write text,
// directory listings, mkdir, rm, rename, exists/stat, and resolution of
// the standard OS data/config/cache directories.
//
// All ops are synchronous. JS errors are thrown by returning Err.

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::fs;
use std::path::Path;

/// Throw a real JS Error with `e`'s message. Uses `Exception::throw_message`
/// (which sets the QuickJS pending exception and returns the `Error::Exception`
/// sentinel) instead of `Error::new_from_js_message` — that constructor is
/// for rquickjs's own JS->Rust type-conversion diagnostics, and its Display
/// impl prepends "Error converting from js 'X' into type 'Y': " to the
/// message, which is what leaked into the UI as a garbled error string.
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set(
            "__cm_fs_read_text",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                    fs::read_to_string(&path).map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        g.set(
            "__cm_fs_write_text",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String, content: String| -> rquickjs::Result<()> {
                    // Auto-create parent directories — matches Tauri's plugin-fs
                    // ergonomics ("save this config file" shouldn't fail just
                    // because the user's never used the app before).
                    if let Some(parent) = Path::new(&path).parent() {
                        if !parent.as_os_str().is_empty() {
                            let _ = fs::create_dir_all(parent);
                        }
                    }
                    fs::write(&path, content).map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        g.set(
            "__cm_fs_exists",
            Function::new(ctx.clone(), |path: String| -> bool {
                Path::new(&path).exists()
            })?,
        )?;

        g.set(
            "__cm_fs_is_file",
            Function::new(ctx.clone(), |path: String| -> bool {
                Path::new(&path).is_file()
            })?,
        )?;

        g.set(
            "__cm_fs_is_dir",
            Function::new(ctx.clone(), |path: String| -> bool {
                Path::new(&path).is_dir()
            })?,
        )?;

        g.set(
            "__cm_fs_read_dir",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String| -> rquickjs::Result<Vec<String>> {
                    let mut out = Vec::new();
                    let it = fs::read_dir(&path).map_err(|e| throw(&ctx, e))?;
                    for entry in it.flatten() {
                        if let Some(s) = entry.file_name().to_str() {
                            out.push(s.to_string());
                        }
                    }
                    out.sort();
                    Ok(out)
                },
            )?,
        )?;

        g.set(
            "__cm_fs_mkdir",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String, recursive: bool| -> rquickjs::Result<()> {
                    if recursive {
                        fs::create_dir_all(&path).map_err(|e| throw(&ctx, e))
                    } else {
                        fs::create_dir(&path).map_err(|e| throw(&ctx, e))
                    }
                },
            )?,
        )?;

        g.set(
            "__cm_fs_rm",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String, recursive: bool| -> rquickjs::Result<()> {
                    let p = Path::new(&path);
                    if p.is_dir() {
                        if recursive {
                            fs::remove_dir_all(p).map_err(|e| throw(&ctx, e))
                        } else {
                            fs::remove_dir(p).map_err(|e| throw(&ctx, e))
                        }
                    } else {
                        fs::remove_file(p).map_err(|e| throw(&ctx, e))
                    }
                },
            )?,
        )?;

        g.set(
            "__cm_fs_rename",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, from: String, to: String| -> rquickjs::Result<()> {
                    fs::rename(&from, &to).map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        // Returns metadata as a JSON string the JS side parses. Keeps the
        // host-import shape boring (string in, string out) without
        // building an rquickjs Object from Rust.
        g.set(
            "__cm_fs_stat",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, path: String| -> rquickjs::Result<String> {
                    let m = fs::metadata(&path).map_err(|e| throw(&ctx, e))?;
                    let modified = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    Ok(format!(
                        r#"{{"size":{},"modifiedMs":{},"isFile":{},"isDir":{}}}"#,
                        m.len(),
                        modified,
                        m.is_file(),
                        m.is_dir(),
                    ))
                },
            )?,
        )?;

        // ─── Standard directories ──────────────────────────────────────
        g.set(
            "__cm_fs_home_dir",
            Function::new(ctx.clone(), || -> Option<String> {
                dirs::home_dir().and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        g.set(
            "__cm_fs_app_data_dir",
            Function::new(ctx.clone(), || -> Option<String> {
                dirs::data_dir().and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        g.set(
            "__cm_fs_app_config_dir",
            Function::new(ctx.clone(), || -> Option<String> {
                dirs::config_dir().and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        g.set(
            "__cm_fs_app_cache_dir",
            Function::new(ctx.clone(), || -> Option<String> {
                dirs::cache_dir().and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        g.set(
            "__cm_fs_temp_dir",
            Function::new(ctx.clone(), || -> String {
                std::env::temp_dir().to_string_lossy().to_string()
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}
