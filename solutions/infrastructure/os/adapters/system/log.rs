// Application logging plugin. Matches `tauri-plugin-log`'s API: apps
// emit log records at trace/debug/info/warn/error levels and the
// runtime ships them to (a) the host console (stderr) and (b) a
// rolling log file under the app's data directory.
//
// Storage layout
// --------------
// `<data_dir>/<app_id>/logs/<app_id>.log`. Old files are rotated when
// they hit the size cap (5 MiB by default), keeping the last N (3 by
// default) as `<app_id>.log.1`, `.log.2`, etc. This is the same
// pattern tauri-plugin-log uses and keeps log discovery predictable
// across platforms.
//
// Thread safety: a single Mutex<File> guards the writer. Apps log
// from the JS thread which is single-threaded for JS calls; the
// global lock is mostly here to prevent torn writes if a native
// plugin ever logs from a worker thread.

use anyhow::Result;
use rquickjs::{Context as JsContext, Function};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ROLLED: usize = 3;

struct LogState {
    file: File,
    path: PathBuf,
    bytes_written: u64,
}

fn state() -> &'static Mutex<Option<LogState>> {
    static S: OnceLock<Mutex<Option<LogState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn app_id() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|d| d.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "carbon-mini".to_string())
}

fn resolve_log_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir().or_else(dirs::data_dir)?;
    let dir = base.join(app_id()).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{}.log", app_id())))
}

fn ensure_open() -> Option<()> {
    let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
    if s.is_some() {
        return Some(());
    }
    let path = resolve_log_path()?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(false)
        .open(&path)
        .ok()?;
    let bytes_written = file.seek(SeekFrom::End(0)).unwrap_or(0);
    *s = Some(LogState {
        file,
        path,
        bytes_written,
    });
    Some(())
}

fn rotate(s: &mut LogState) -> std::io::Result<()> {
    // Drop oldest, shift others up by one. New file starts empty.
    let base = s.path.clone();
    let _ = std::fs::remove_file(base.with_extension(format!("log.{}", MAX_ROLLED)));
    for i in (1..MAX_ROLLED).rev() {
        let src = base.with_extension(format!("log.{i}"));
        let dst = base.with_extension(format!("log.{}", i + 1));
        let _ = std::fs::rename(src, dst);
    }
    let _ = std::fs::rename(&base, base.with_extension("log.1"));
    s.file = OpenOptions::new().create(true).append(true).open(&base)?;
    s.bytes_written = 0;
    Ok(())
}

fn write_line(level: &str, target: &str, message: &str) {
    // Console mirror — always on. Apps typically run with stderr
    // attached during dev; in production it's a no-op.
    eprintln!("[{level}] {target}: {message}");
    if ensure_open().is_none() {
        return;
    }
    let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some(s) = guard.as_mut() else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{ts} {level:5} {target} {message}\n");
    let bytes = line.as_bytes();
    if s.bytes_written + bytes.len() as u64 > MAX_BYTES {
        let _ = rotate(s);
    }
    if s.file.write_all(bytes).is_ok() {
        s.bytes_written += bytes.len() as u64;
    }
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();
        // Single entry point: __cm_log(level, target, message). The
        // JS wrapper exposes `log.trace/.debug/.info/.warn/.error`.
        g.set(
            "__cm_log",
            Function::new(
                ctx.clone(),
                |level: String, target: String, message: String| {
                    write_line(&level, &target, &message);
                },
            )?,
        )?;
        g.set(
            "__cm_log_path",
            Function::new(ctx.clone(), || {
                ensure_open();
                let guard = state().lock().unwrap_or_else(|e| e.into_inner());
                guard
                    .as_ref()
                    .map(|s| s.path.to_string_lossy().to_string())
                    .unwrap_or_default()
            })?,
        )?;
        Ok(())
    })?;
    Ok(())
}
