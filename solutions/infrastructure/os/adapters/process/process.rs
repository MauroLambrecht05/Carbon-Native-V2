// Child-process host imports. Two modes:
//
//   exec(cmd, args, opts) — one-shot, blocks until child exits, returns
//     {stdout, stderr, code}. The right tool for "git status",
//     "node --version", etc.
//
//   spawn(cmd, args, opts) → handle id — fire-and-forget, returns an id
//     the JS side uses with separate read_stdout/write_stdin/wait/kill
//     calls. The right tool for long-running children that need
//     streaming input/output (e.g. a build watcher, a language server,
//     a dev server). NOT a PTY — for terminal emulation you want a real
//     PTY backend (deferred).
//
// All state lives in a global registry keyed by an autoincrementing
// handle id. Threads read each spawned child's stdout/stderr into
// buffers; reads from JS drain those buffers (non-blocking).

use anyhow::Result;
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;

struct Handle {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout_buf: std::sync::Arc<Mutex<Vec<u8>>>,
    stderr_buf: std::sync::Arc<Mutex<Vec<u8>>>,
}

fn registry() -> &'static Mutex<HashMap<u32, Handle>> {
    static R: OnceLock<Mutex<HashMap<u32, Handle>>> = OnceLock::new();
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

fn parse_args(args_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(args_json).unwrap_or_default()
}

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        // exec: blocking one-shot. Returns JSON
        // `{stdout, stderr, code}` so the JS wrapper can parse without
        // needing a multi-return shape.
        g.set(
            "__cm_proc_exec",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>,
                 cmd: String,
                 args_json: String,
                 cwd: String|
                 -> rquickjs::Result<String> {
                    let args = parse_args(&args_json);
                    let mut c = Command::new(&cmd);
                    c.args(&args);
                    if !cwd.is_empty() {
                        c.current_dir(&cwd);
                    }
                    let out = c.output().map_err(|e| throw(&ctx, e))?;
                    // JSON-escape only the bytes that need it. stdout / stderr
                    // can hold arbitrary bytes; we lossy-utf8 them so the JS
                    // string is well-formed. Apps that need raw bytes can layer
                    // their own protocol on top.
                    let stdout =
                        serde_json::to_string(&String::from_utf8_lossy(&out.stdout).into_owned())
                            .unwrap_or_default();
                    let stderr =
                        serde_json::to_string(&String::from_utf8_lossy(&out.stderr).into_owned())
                            .unwrap_or_default();
                    let code = out.status.code().unwrap_or(-1);
                    Ok(format!(
                        r#"{{"stdout":{},"stderr":{},"code":{}}}"#,
                        stdout, stderr, code
                    ))
                },
            )?,
        )?;

        // spawn: returns u32 handle. The handle is the only way to talk
        // to the child from now on.
        g.set(
            "__cm_proc_spawn",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>,
                 cmd: String,
                 args_json: String,
                 cwd: String|
                 -> rquickjs::Result<u32> {
                    let args = parse_args(&args_json);
                    let mut c = Command::new(&cmd);
                    c.args(&args);
                    if !cwd.is_empty() {
                        c.current_dir(&cwd);
                    }
                    c.stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                    let mut child = c.spawn().map_err(|e| throw(&ctx, e))?;
                    let stdin = child.stdin.take();
                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();

                    let stdout_buf = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
                    let stderr_buf = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));

                    // Reader threads. We drain each stream by line into the
                    // shared buffer until EOF.
                    if let Some(s) = stdout {
                        let buf = stdout_buf.clone();
                        thread::spawn(move || {
                            let mut r = BufReader::new(s);
                            let mut chunk = [0u8; 4096];
                            loop {
                                match r.read(&mut chunk) {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => {
                                        let mut g = buf.lock().unwrap_or_else(|e| e.into_inner());
                                        g.extend_from_slice(&chunk[..n]);
                                    }
                                }
                            }
                        });
                    }
                    if let Some(s) = stderr {
                        let buf = stderr_buf.clone();
                        thread::spawn(move || {
                            let mut r = BufReader::new(s);
                            let mut chunk = [0u8; 4096];
                            loop {
                                match r.read(&mut chunk) {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => {
                                        let mut g = buf.lock().unwrap_or_else(|e| e.into_inner());
                                        g.extend_from_slice(&chunk[..n]);
                                    }
                                }
                            }
                        });
                    }

                    let id = next_id();
                    registry().lock().unwrap_or_else(|e| e.into_inner()).insert(
                        id,
                        Handle {
                            child,
                            stdin,
                            stdout_buf,
                            stderr_buf,
                        },
                    );
                    Ok(id)
                },
            )?,
        )?;

        // write_stdin: appends bytes to the child's stdin. Returns
        // bytes-written; 0 means stdin was already closed or never
        // existed (Stdio::null piped this way is unusual but possible).
        g.set(
            "__cm_proc_write_stdin",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, id: u32, data: String| -> rquickjs::Result<u32> {
                    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(h) = reg.get_mut(&id) {
                        if let Some(s) = h.stdin.as_mut() {
                            let bytes = data.as_bytes();
                            s.write_all(bytes).map_err(|e| throw(&ctx, e))?;
                            return Ok(bytes.len() as u32);
                        }
                    }
                    Ok(0)
                },
            )?,
        )?;

        // read_stdout: drain and return whatever's in the stdout buffer
        // since the last read. Non-blocking.
        g.set(
            "__cm_proc_read_stdout",
            Function::new(ctx.clone(), |id: u32| -> String {
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = reg.get(&id) {
                    let mut buf = h.stdout_buf.lock().unwrap_or_else(|e| e.into_inner());
                    let bytes = std::mem::take(&mut *buf);
                    return String::from_utf8_lossy(&bytes).into_owned();
                }
                String::new()
            })?,
        )?;

        g.set(
            "__cm_proc_read_stderr",
            Function::new(ctx.clone(), |id: u32| -> String {
                let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = reg.get(&id) {
                    let mut buf = h.stderr_buf.lock().unwrap_or_else(|e| e.into_inner());
                    let bytes = std::mem::take(&mut *buf);
                    return String::from_utf8_lossy(&bytes).into_owned();
                }
                String::new()
            })?,
        )?;

        // kill: SIGKILL on Unix / TerminateProcess on Windows. The
        // child entry is removed from the registry.
        g.set(
            "__cm_proc_kill",
            Function::new(ctx.clone(), |id: u32| -> rquickjs::Result<()> {
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(mut h) = reg.remove(&id) {
                    let _ = h.child.kill();
                    let _ = h.child.wait();
                }
                Ok(())
            })?,
        )?;

        // wait: block until the child exits, return its exit code.
        // Removes from registry. Pair with kill if you want to abort.
        g.set(
            "__cm_proc_wait",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, id: u32| -> rquickjs::Result<i32> {
                    let mut h = match registry()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id)
                    {
                        Some(h) => h,
                        None => return Ok(-1),
                    };
                    let status = h.child.wait().map_err(|e| throw(&ctx, e))?;
                    Ok(status.code().unwrap_or(-1))
                },
            )?,
        )?;

        // try_status: non-blocking exit-code probe. Returns -2 while
        // still running, real exit code on completion. Useful for
        // polling loops without blocking the JS event loop.
        g.set(
            "__cm_proc_try_status",
            Function::new(ctx.clone(), |id: u32| -> i32 {
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = reg.get_mut(&id) {
                    match h.child.try_wait() {
                        Ok(Some(status)) => status.code().unwrap_or(-1),
                        Ok(None) => -2, // still running
                        Err(_) => -1,
                    }
                } else {
                    -1
                }
            })?,
        )?;

        g.set(
            "__cm_proc_pid_self",
            Function::new(ctx.clone(), || -> u32 { std::process::id() })?,
        )?;

        // Relaunch the current process. Spawns a fresh instance of the
        // current executable with the same argv (skipping argv[0]) and
        // then schedules the current process to exit after a short
        // delay so the new instance has time to take over the window.
        // Used by `@tauri-apps/plugin-process::relaunch()` (after an
        // update applies, after settings that require a restart, …).
        g.set(
            "__cm_proc_relaunch_self",
            Function::new(ctx.clone(), |ctx: Ctx<'_>| -> rquickjs::Result<()> {
                let exe = std::env::current_exe().map_err(|e| throw(&ctx, e))?;
                let args: Vec<String> = std::env::args().skip(1).collect();
                let mut cmd = Command::new(&exe);
                cmd.args(&args);
                cmd.spawn().map_err(|e| throw(&ctx, e))?;
                // Schedule self-exit AFTER the spawn succeeds. Sleeping in
                // a detached thread keeps the JS event loop free so the
                // caller's promise resolves before the process dies.
                thread::spawn(|| {
                    thread::sleep(std::time::Duration::from_millis(50));
                    std::process::exit(0);
                });
                Ok(())
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}
