// PTY (pseudo-terminal) host imports.
//
// Wraps `portable-pty` so a Carbon app can host its own terminal
// emulator (xterm.js-style) or AI coding agent that spawns shells.
// Same model as `process.rs`: spawn returns an id; subsequent
// write/resize/kill calls operate on that id. Unlike `process.rs`,
// the PTY's stdout/stderr are merged into a single byte stream (that's
// how PTYs work — there's one terminal).
//
// Output streaming
// -----------------
// A reader thread per session drains the PTY master into a per-session
// `Mutex<Vec<u8>>` buffer. The JS side polls via `__cm_pty_read(id)`
// which drains the buffer atomically and returns the bytes as base64
// (binary-safe through the JS string boundary). For low-latency apps
// we ALSO post a `UserEvent::PtyOutput` event whenever new bytes
// arrive — the main loop's event handler can then eval a JS dispatcher
// that flushes the buffer to xterm.js. This dual model lets apps pick
// between "polling on rAF" and "event-driven push" without the runtime
// having to commit to one upfront.

use anyhow::Result;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use crate::net::post;
use carbon_runtime_contract::UserEvent;

struct PtyHandle {
    /// Hold onto the master so resize() works after spawn — dropping it
    /// would close the terminal. Stored behind a Mutex because Send
    /// requirements on the master object vary across platforms.
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Writer for the master end. Reads happen on the reader thread.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Buffered output not yet drained by JS.
    buf: Arc<Mutex<Vec<u8>>>,
    /// Child handle for kill/wait. Some PTY children expose extra
    /// portable-pty-specific methods; we keep the dyn trait object.
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

fn registry() -> &'static Mutex<HashMap<u32, Arc<PtyHandle>>> {
    static R: OnceLock<Mutex<HashMap<u32, Arc<PtyHandle>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u32 {
    static N: OnceLock<Mutex<u32>> = OnceLock::new();
    let m = N.get_or_init(|| Mutex::new(1));
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    let id = *g;
    *g = g.wrapping_add(1);
    id
}

/// Throw a real JS Error with `e`'s message (see fs.rs's `throw` doc
/// comment for why not `Error::new_from_js_message`).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

#[derive(serde::Deserialize, Default)]
struct SpawnArgs {
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        // spawn(cmd, optsJson) → id. opts shape:
        //   { args?: string[], cwd?: string, env?: Record<string, string>,
        //     cols?: number, rows?: number }
        g.set(
            "__cm_pty_spawn",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, cmd: String, opts_json: String| -> rquickjs::Result<u32> {
                    let opts: SpawnArgs = serde_json::from_str(&opts_json).unwrap_or_default();
                    let pty_system = native_pty_system();
                    let pair = pty_system
                        .openpty(PtySize {
                            rows: opts.rows.max(1),
                            cols: opts.cols.max(1),
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .map_err(|e| throw(&ctx, e))?;

                    let mut command = CommandBuilder::new(&cmd);
                    for a in &opts.args {
                        command.arg(a);
                    }
                    if let Some(cwd) = opts.cwd.as_ref() {
                        if !cwd.is_empty() {
                            command.cwd(cwd);
                        }
                    }
                    if let Some(env) = opts.env.as_ref() {
                        for (k, v) in env {
                            command.env(k, v);
                        }
                    }

                    let child = pair
                        .slave
                        .spawn_command(command)
                        .map_err(|e| throw(&ctx, e))?;
                    // Drop the slave handle — the child holds its own copy
                    // of the slave fd. Keeping it open here would leave a
                    // descriptor that prevents the master from seeing EOF.
                    drop(pair.slave);

                    let reader = pair.master.try_clone_reader().map_err(|e| throw(&ctx, e))?;
                    let writer = pair.master.take_writer().map_err(|e| throw(&ctx, e))?;
                    let master = Arc::new(Mutex::new(pair.master));

                    let id = next_id();
                    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

                    // Reader thread: drains master output into the buffer
                    // and posts a UserEvent so JS can flush via the
                    // dispatcher. Exits cleanly on EOF.
                    {
                        let buf = buf.clone();
                        thread::Builder::new()
                            .name(format!("carbon-mini-pty-{id}"))
                            .spawn(move || {
                                let mut reader = reader;
                                let mut chunk = [0u8; 8192];
                                loop {
                                    match reader.read(&mut chunk) {
                                        Ok(0) | Err(_) => break,
                                        Ok(n) => {
                                            {
                                                let mut g =
                                                    buf.lock().unwrap_or_else(|e| e.into_inner());
                                                g.extend_from_slice(&chunk[..n]);
                                            }
                                            post(UserEvent::PtyOutput { id });
                                        }
                                    }
                                }
                                // EOF — emit a final signal so the JS side
                                // can mark the session as closed.
                                post(UserEvent::PtyExit { id });
                            })
                            .ok();
                    }

                    let handle = Arc::new(PtyHandle {
                        master,
                        writer: Mutex::new(writer),
                        buf,
                        child: Mutex::new(child),
                    });
                    registry()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(id, handle);
                    Ok(id)
                },
            )?,
        )?;

        // write(id, data) → bytes_written. Data is raw UTF-8 text or
        // arbitrary bytes — apps that need to send binary (e.g. typing
        // a literal NUL) should send them as a JS string; QuickJS
        // preserves byte values for Latin-1 chars and we treat the
        // string as bytes here.
        g.set(
            "__cm_pty_write",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, id: u32, data: String| -> rquickjs::Result<u32> {
                    let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(h) = reg.get(&id) {
                        let mut w = h.writer.lock().unwrap_or_else(|e| e.into_inner());
                        let bytes = data.as_bytes();
                        w.write_all(bytes).map_err(|e| throw(&ctx, e))?;
                        let _ = w.flush();
                        return Ok(bytes.len() as u32);
                    }
                    Ok(0)
                },
            )?,
        )?;

        // resize(id, cols, rows). Sends SIGWINCH on Unix / equivalent
        // on Windows so the child redraws at the new size.
        g.set(
            "__cm_pty_resize",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, id: u32, cols: u32, rows: u32| -> rquickjs::Result<()> {
                    let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(h) = reg.get(&id) {
                        let m = h.master.lock().unwrap_or_else(|e| e.into_inner());
                        m.resize(PtySize {
                            rows: (rows.max(1).min(u16::MAX as u32)) as u16,
                            cols: (cols.max(1).min(u16::MAX as u32)) as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .map_err(|e| throw(&ctx, e))?;
                    }
                    Ok(())
                },
            )?,
        )?;

        // read(id) → base64. Drains the buffered output bytes and
        // returns them base64-encoded. Empty string if no output is
        // available. The buffer is reset on each call.
        g.set(
            "__cm_pty_read",
            Function::new(ctx.clone(), |id: u32| -> String {
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = reg.get(&id) {
                    let mut buf = h.buf.lock().unwrap_or_else(|e| e.into_inner());
                    if buf.is_empty() {
                        return String::new();
                    }
                    let bytes = std::mem::take(&mut *buf);
                    return base64::engine::general_purpose::STANDARD.encode(&bytes);
                }
                String::new()
            })?,
        )?;

        // kill(id). Terminates the child; the reader thread sees EOF
        // and exits, posting PtyExit. The registry entry stays around
        // so apps can still drain leftover output via read().
        g.set(
            "__cm_pty_kill",
            Function::new(ctx.clone(), |id: u32| -> rquickjs::Result<()> {
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = reg.get(&id) {
                    let mut c = h.child.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = c.kill();
                }
                Ok(())
            })?,
        )?;

        // close(id). Hard-removes the registry entry — the child is
        // killed, its handles dropped. Apps should call this when a
        // terminal tab is closed permanently. Distinct from kill() in
        // that the session can no longer be read from afterward.
        g.set(
            "__cm_pty_close",
            Function::new(ctx.clone(), |id: u32| -> rquickjs::Result<()> {
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = reg.remove(&id) {
                    let _ = h.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
                }
                Ok(())
            })?,
        )?;

        // wait(id) → exit_code. Blocks until the child exits. Returns
        // -1 if the entry is gone or the child failed to report a
        // status code (signaled exits on Unix).
        g.set(
            "__cm_pty_wait",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, id: u32| -> rquickjs::Result<i32> {
                    let handle = {
                        let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                        reg.get(&id).cloned()
                    };
                    let Some(h) = handle else {
                        return Ok(-1);
                    };
                    // Wait outside the registry lock so other PTY calls
                    // (e.g. resize from a render loop) don't block.
                    let status = {
                        let mut c = h.child.lock().unwrap_or_else(|e| e.into_inner());
                        c.wait().map_err(|e| throw(&ctx, e))?
                    };
                    Ok(status.exit_code() as i32)
                },
            )?,
        )?;

        Ok(())
    })?;
    Ok(())
}
