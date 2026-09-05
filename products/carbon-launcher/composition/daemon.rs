// The pre-warmed daemon (Phase B). A `carbon-launcher run` that finds it
// listening hands its request to an already-running, already-launched
// `carbon-mini --pool-wait` process instead of paying the ~65-83ms OS
// process-creation cost itself. Any failure here — daemon unreachable,
// pool empty, a stale pooled binary — falls straight through to the
// direct-spawn path in `main.rs`; this is a pure optimization, never a
// hard dependency of `run`/`dev` working at all.
//
// v1 scope, stated plainly: only the `mini` backend is pooled (`blitz` has
// no `window-visible` marker to relay against and is a much rarer path —
// any other backend gets an immediate miss response). The pooled process's
// STDOUT is discarded — only stderr (the timing trace, the window-visible
// marker, warnings) is relayed to the client — so an app's own
// `console.log` output is not visible for a daemon-served launch. Ctrl-C
// against a daemon-served launch is a hard `TerminateProcess`, not the
// graceful shutdown a directly-spawned process gets via console signal
// broadcast (the pooled process isn't attached to the client's console,
// so that broadcast never reaches it). Both are real, deliberate v1
// simplifications, not oversights — see this module's own functions for
// where each one lives.

use crate::pipe::{PipeConnection, PipeServer};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::VecDeque;
use std::io::BufRead;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Win32 process-creation flags for `ensure_daemon`'s inner spawn — not in
/// windows-sys's `CREATE_*`/`DETACHED_PROCESS` constant set exposed via this
/// crate's enabled features, so named directly (both are long-stable ABI
/// values, unchanged since Windows NT).
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// How long a pooled instance may sit unclaimed before it's killed and not
/// replaced until real demand returns — see this module's doc comment.
const UNCLAIMED_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POOL_TARGET: usize = 1;
const EXIT_MARKER: &str = "__CARBON_LAUNCHER_EXIT__:";

pub fn pipe_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
    format!("carbon-launcher-daemon-{user}")
}

#[derive(Deserialize)]
struct Request {
    project_dir: String,
    #[serde(default)]
    dev_mode: bool,
    backend: String,
}

enum StderrEvent {
    Line(String),
    Exited(i32),
}

struct PooledInstance {
    pid: u32,
    handoff_file: PathBuf,
    spawned_at: Instant,
    lines_rx: mpsc::Receiver<StderrEvent>,
    runtime_size: u64,
    runtime_mtime_ms: f64,
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(-1.0)
}

/// Kills a process this daemon spawned but never handed off (stale, or
/// unclaimed past `UNCLAIMED_TIMEOUT`) — via PID, not a retained `Child`
/// handle, since the reader thread in `spawn_pooled_instance` owns that.
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

fn spawn_pooled_instance(runtime_exe: &Path) -> Result<PooledInstance> {
    let handoff_file = std::env::temp_dir().join(format!(
        "carbon-launcher-pool-{}-{}.json",
        std::process::id(),
        Instant::now().elapsed().as_nanos() // monotonic-ish uniqueness, no uuid dep needed
    ));
    let mut child = Command::new(runtime_exe)
        .arg("--pool-wait")
        .arg(&handoff_file)
        // A direct `carbon run` sets this in ITS OWN process env (see
        // run.command.ts), which its own direct-spawned child inherits for
        // free. A pooled instance has no such parent to inherit from — it's
        // spawned by the daemon, a completely separate process tree started
        // via DaemonClient.ts's `ensure-daemon` call, which never set this
        // either. Without it, every daemon-served launch printed the
        // runtime's full internal [timing] phase trace unconditionally,
        // regardless of whether the request asked for --verbose. The pool is
        // warmed generically, before any specific request (and its
        // verbosity) is known, so this matches the common case — a
        // --verbose request that happens to land on a daemon hit won't see
        // the runtime's own trace; see try_daemon's/tryDaemonRun's own
        // relay, which only ever forwards what the pooled process actually
        // printed.
        .env("CARBON_NO_TIMING", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning pooled {}", runtime_exe.display()))?;
    let pid = child.id();
    let stderr = child.stderr.take().expect("stderr was piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().map_while(std::result::Result::ok) {
            if tx.send(StderrEvent::Line(line)).is_err() {
                // Receiver dropped (the pool entry was pruned/discarded) —
                // stop reading; the process itself gets killed separately
                // by whoever discarded it (see `kill_pid` call sites).
                return;
            }
        }
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
        let _ = tx.send(StderrEvent::Exited(code));
    });
    let meta = std::fs::metadata(runtime_exe)?;
    Ok(PooledInstance {
        pid,
        handoff_file,
        spawned_at: Instant::now(),
        lines_rx: rx,
        runtime_size: meta.len(),
        runtime_mtime_ms: mtime_ms(&meta),
    })
}

/// Tops the pool up to `POOL_TARGET`, discarding (and killing) any entry
/// that's sat unclaimed past `UNCLAIMED_TIMEOUT`.
fn refill(pool: &Mutex<VecDeque<PooledInstance>>, runtime_exe: Option<&Path>) {
    let Some(runtime_exe) = runtime_exe else { return };
    let mut pool = pool.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let mut i = 0;
    while i < pool.len() {
        if now.duration_since(pool[i].spawned_at) >= UNCLAIMED_TIMEOUT {
            let stale = pool.remove(i).unwrap();
            eprintln!(
                "[carbon-launcher-daemon] pooled pid={} unclaimed for {:?}, reclaiming",
                stale.pid, UNCLAIMED_TIMEOUT
            );
            kill_pid(stale.pid);
        } else {
            i += 1;
        }
    }
    while pool.len() < POOL_TARGET {
        match spawn_pooled_instance(runtime_exe) {
            Ok(inst) => {
                eprintln!("[carbon-launcher-daemon] pooled pid={}", inst.pid);
                pool.push_back(inst);
            }
            Err(e) => {
                eprintln!("[carbon-launcher-daemon] failed to pool an instance: {e:#}");
                break; // don't spin — try again on the next refill trigger
            }
        }
    }
}

fn handle_connection(
    conn: &mut PipeConnection,
    pool: &Arc<Mutex<VecDeque<PooledInstance>>>,
) -> Result<()> {
    let Some(line) = conn.read_line()? else {
        return Ok(());
    };
    let req: Request = match serde_json::from_str(&line) {
        Ok(r) => r,
        Err(e) => {
            conn.write_line(&format!(r#"{{"ok":false,"reason":"bad request: {e}"}}"#))?;
            return Ok(());
        }
    };

    if req.backend != "mini" {
        conn.write_line(r#"{"ok":false,"reason":"backend not pooled"}"#)?;
        return Ok(());
    }

    let runtime_exe = crate::resolve_runtime_binary(&req.backend);

    let instance = {
        let mut pool = pool.lock().unwrap_or_else(|e| e.into_inner());
        let popped = pool.pop_front();
        // Staleness check — see this crate's module doc: a pooled binary
        // that no longer matches what runtime resolution would pick RIGHT
        // NOW (the runtime was rebuilt while this instance sat waiting)
        // must not be handed off; discard and let the caller fall back.
        match (popped, &runtime_exe) {
            (Some(inst), Some(exe)) => match std::fs::metadata(exe) {
                Ok(meta)
                    if meta.len() == inst.runtime_size && mtime_ms(&meta) == inst.runtime_mtime_ms =>
                {
                    Some(inst)
                }
                _ => {
                    eprintln!(
                        "[carbon-launcher-daemon] pooled pid={} is stale (runtime rebuilt), discarding",
                        inst.pid
                    );
                    kill_pid(inst.pid);
                    None
                }
            },
            (Some(inst), None) => {
                kill_pid(inst.pid);
                None
            }
            (None, _) => None,
        }
    };

    let Some(instance) = instance else {
        conn.write_line(r#"{"ok":false,"reason":"pool empty or stale"}"#)?;
        refill(pool, runtime_exe.as_deref());
        return Ok(());
    };

    let handoff = serde_json::json!({
        "project_dir": req.project_dir,
        "dev_mode": req.dev_mode,
        "window_opts_json": "{}",
    });
    std::fs::write(&instance.handoff_file, handoff.to_string())
        .context("writing pool handoff file")?;

    conn.write_line(&format!(r#"{{"ok":true,"pid":{}}}"#, instance.pid))?;

    loop {
        match instance.lines_rx.recv() {
            Ok(StderrEvent::Line(l)) => conn.write_line(&l)?,
            Ok(StderrEvent::Exited(code)) => {
                conn.write_line(&format!("{EXIT_MARKER}{code}"))?;
                break;
            }
            Err(_) => {
                conn.write_line(&format!("{EXIT_MARKER}1"))?;
                break;
            }
        }
    }

    refill(pool, runtime_exe.as_deref());
    Ok(())
}

pub fn run_daemon() -> Result<()> {
    let name = pipe_name();
    let server = match PipeServer::bind(&name) {
        Ok(s) => s,
        // Another daemon already holds this pipe — see PipeServer::bind's
        // doc comment. Expected whenever a warm-up from a `carbon run`/`carbon
        // dev` (DaemonClient.ts's `warmDaemonInBackground`) races an already-
        // running daemon, or a user runs `carbon-launcher daemon` by hand
        // while one is up: exit quietly, there is nothing to do here.
        Err(e) if e.to_string() == crate::pipe::PIPE_ALREADY_BOUND => {
            eprintln!("[carbon-launcher-daemon] another daemon is already running, exiting");
            return Ok(());
        }
        Err(e) => return Err(e.context("binding daemon pipe")),
    };
    eprintln!(r"[carbon-launcher-daemon] listening on \\.\pipe\{name}");

    let last_activity = Arc::new(Mutex::new(Instant::now()));
    let pool: Arc<Mutex<VecDeque<PooledInstance>>> = Arc::new(Mutex::new(VecDeque::new()));

    {
        let last_activity = last_activity.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let idle = last_activity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .elapsed();
            if idle >= IDLE_TIMEOUT {
                eprintln!("[carbon-launcher-daemon] idle for {idle:?}, exiting");
                std::process::exit(0);
            }
        });
    }

    refill(&pool, crate::resolve_runtime_binary("mini").as_deref());

    loop {
        let mut conn = match server.accept() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[carbon-launcher-daemon] accept failed: {e:#}");
                continue;
            }
        };
        *last_activity.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        if let Err(e) = handle_connection(&mut conn, &pool) {
            eprintln!("[carbon-launcher-daemon] connection error: {e:#}");
        }
        conn.disconnect();
    }
}

/// Best-effort, synchronous, and fast: if a daemon is already listening,
/// does nothing. Otherwise spawns one directly via `CreateProcessW` with
/// `DETACHED_PROCESS | CREATE_NO_WINDOW`, which never allocates a console
/// for the child — the reliable, native way to background a console-
/// subsystem process on Windows.
///
/// This exists as its own subcommand, invoked as a normal (non-detached)
/// child from TypeScript (see DaemonClient.ts), specifically because relying
/// on a JS runtime's own `detached`/`windowsHide` spawn flags to hide the
/// DAEMON's window directly did not work: Bun's `node:child_process` compat
/// layer on Windows did not reliably suppress the console window for a
/// `detached: true` spawn even with `windowsHide: true` set, so every
/// `carbon run`/`carbon dev` that warmed a missing daemon popped a visible
/// console window alongside the app's own window. Splitting the "is one
/// running, and if not spawn one" decision into this native subcommand
/// avoids that entirely: the outer TypeScript-side call is a plain,
/// non-detached spawn (never allocates a window on its own, same as any
/// other subprocess this CLI already shells out to), and the ONE spawn that
/// actually needs to survive past its parent's exit is done here, in Rust,
/// with the real, well-established Win32 flags for it — not delegated to a
/// runtime's cross-platform abstraction over them.
///
/// Always returns 0: this is a warm-up, never a hard dependency of `carbon
/// run`/`carbon dev` working — a failure here (binary missing, spawn denied)
/// is silently swallowed rather than surfaced as a command error.
pub fn ensure_daemon() -> i32 {
    let name = pipe_name();
    if PipeConnection::connect(&name).is_ok() {
        return 0; // already running
    }
    let Ok(self_exe) = std::env::current_exe() else { return 0 };
    let _ = Command::new(&self_exe)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn();
    0
}

/// Client side: try the daemon for `backend`/`project_dir`/`dev_mode`.
/// `None` means "no daemon reachable, or it said no" — the caller falls
/// back to a direct spawn, never an error the user sees. `Some(code)` means
/// the daemon fully served the launch (including printing "ready" the
/// moment the SAME `window-visible` marker `spawn.rs` watches for on a
/// direct spawn arrives, relayed live) and the process should exit with
/// `code`.
pub fn try_daemon(project_dir: &Path, backend: &str, dev_mode: bool, t0: Instant, app_name: &str) -> Option<i32> {
    let name = pipe_name();
    let mut conn = PipeConnection::connect(&name).ok()?;
    let req = serde_json::json!({
        "project_dir": project_dir.to_string_lossy(),
        "dev_mode": dev_mode,
        "backend": backend,
    });
    conn.write_line(&req.to_string()).ok()?;
    let first = conn.read_line().ok()??;
    let ok = first.contains("\"ok\":true");
    if !ok {
        return None;
    }

    let mut printed_ready = false;
    loop {
        match conn.read_line() {
            Ok(Some(line)) => {
                if let Some(code_str) = line.strip_prefix(EXIT_MARKER) {
                    return Some(code_str.trim().parse().unwrap_or(1));
                }
                if line.trim() == crate::spawn::WINDOW_VISIBLE_MARKER {
                    if !printed_ready {
                        printed_ready = true;
                        eprintln!("\u{2713} {app_name} ready in {}ms", t0.elapsed().as_millis());
                    }
                    continue; // don't also echo the raw marker line itself
                }
                eprintln!("{line}");
            }
            // Pipe closed before either an exit marker or a window-visible
            // marker ever arrived — treat as a hard failure, same posture
            // as `spawn.rs`'s own child-exited-before-visible case.
            Ok(None) | Err(_) => return Some(1),
        }
    }
}
