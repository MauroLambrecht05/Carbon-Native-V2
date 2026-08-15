// shell_run_command / shell_session_* / shell_bg_* — invoke-channel commands
// ported from the app's original Tauri backend (see
// examples/terax-ai-tauri-ref/src-tauri/src/modules/shell/{mod,session,background,ringbuffer}.rs).
//
// Three distinct process-execution primitives, all separate from the
// interactive PTY terminal (native/pty.rs) which is a different feature
// (a real allocated terminal for the user to type into):
//   - shell_run_command   — one-shot, blocks until exit or timeout.
//   - shell_session_*     — a persistent agent shell: cwd persists across
//     `run` calls (tracked via an invisible sentinel line appended to each
//     command so we can recover the post-command cwd without a real PTY).
//   - shell_bg_*          — fire-and-forget background processes with a
//     bounded ring-buffer log apps can poll (`shell_bg_logs`).
//
// Note on blocking: like the existing `__cm_proc_wait` host import
// (native/process.rs), `shell_run_command` / `shell_session_run` block the
// calling thread until the child exits or the timeout elapses. Since
// carbon-mini is single-threaded (the same thread runs the event loop,
// paint, and JS), a long-running command visibly freezes the window for
// its duration — this matches `__cm_proc_wait`'s existing behavior and the
// bounded default (30s, 300s hard cap) keeps the worst case finite. Apps
// that need a non-blocking long-running command should use the
// `shell_bg_*` family (poll `shell_bg_logs` from a rAF/interval) instead.

use serde::Serialize;
use serde_json::Value;
use shared_child::SharedChild;
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const RING_CAP: usize = 4 * 1024 * 1024;
const CWD_SENTINEL: &str = "__CARBON_CWD__";

fn to_value<T: Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn timeout_dur(args: &Value) -> Duration {
    let secs = args
        .get("timeoutSecs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    Duration::from_secs(secs.clamp(1, MAX_TIMEOUT_SECS))
}

fn build_oneshot_command(command: &str, cwd: Option<&str>) -> Command {
    #[cfg(windows)]
    let mut cmd = carbon_platform::windows::shell_command(command);
    #[cfg(not(windows))]
    let mut cmd = carbon_platform::unix::shell_command(command);
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd
}

fn drain<R: Read>(reader: &mut R) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= MAX_OUTPUT_BYTES {
                    truncated = true;
                    continue;
                }
                let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}

#[derive(Serialize)]
struct CommandOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
}

fn run_blocking(
    command: String,
    cwd: Option<String>,
    dur: Duration,
) -> Result<CommandOutput, String> {
    let mut cmd = build_oneshot_command(&command, cwd.as_deref());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    // Drain stdout/stderr on background threads so a full pipe buffer
    // can't deadlock the child while we poll try_wait below.
    let stdout_handle = thread::spawn(move || drain(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || drain(&mut stderr_pipe));

    let started = Instant::now();
    let mut timed_out = false;
    let exit_code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if started.elapsed() >= dur {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        thread::sleep(POLL_INTERVAL);
    };

    let (stdout_bytes, stdout_truncated) = stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_truncated) = stderr_handle.join().unwrap_or((Vec::new(), false));

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

/// Runs a one-shot command via PowerShell (Windows) / the user's login
/// shell (Unix). Output is capped and the process is force-killed on
/// timeout. Deliberately not piped into the interactive PTY — that would
/// fight the user's own typing; AI tool calls get their own structured
/// result instead.
pub fn shell_run_command(args: &Value) -> Result<Value, String> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if command.is_empty() {
        return Err("empty command".into());
    }
    let cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    if let Some(dir) = cwd {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }
    let dur = timeout_dur(args);
    let out = run_blocking(command, cwd.map(str::to_string), dur)?;
    to_value(&out)
}

// ─── Persistent agent shell sessions ───────────────────────────────────────

struct ShellSession {
    cwd: Mutex<String>,
    pristine: AtomicBool,
}

#[derive(Serialize)]
struct SessionRunOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
    cwd_after: String,
}

fn wrap_with_sentinel(command: &str) -> String {
    #[cfg(windows)]
    return carbon_platform::windows::wrap_with_sentinel(command, CWD_SENTINEL);
    #[cfg(not(windows))]
    return carbon_platform::unix::wrap_with_sentinel(command, CWD_SENTINEL);
}

fn strip_cwd_sentinel(stdout: &str) -> (String, Option<String>) {
    if let Some(idx) = stdout.rfind(CWD_SENTINEL) {
        let before = &stdout[..idx];
        let after = &stdout[idx + CWD_SENTINEL.len()..];
        let cwd_line = after.lines().next().unwrap_or("").trim();
        return (
            before.trim_end_matches('\n').to_string(),
            Some(cwd_line.to_string()),
        );
    }
    (stdout.to_string(), None)
}

impl ShellSession {
    fn run(
        &self,
        command: String,
        cwd_hint: Option<String>,
        dur: Duration,
    ) -> Result<SessionRunOutput, String> {
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if self.pristine.load(Ordering::Acquire) {
            if let Some(hint) = cwd_hint.filter(|s| !s.is_empty()) {
                if std::path::Path::new(&hint).is_dir() {
                    *self.cwd.lock().unwrap_or_else(|e| e.into_inner()) = hint;
                }
            }
        }
        let cwd = self.cwd.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let wrapped = wrap_with_sentinel(&trimmed);

        let (tx, rx) = mpsc::channel::<Result<CommandOutput, String>>();
        let cwd_for_thread = cwd.clone();
        thread::spawn(move || {
            let _ = tx.send(run_blocking(wrapped, Some(cwd_for_thread), dur));
        });
        let raw = rx.recv().map_err(|e| e.to_string())??;
        self.pristine.store(false, Ordering::Release);

        let (stdout_clean, cwd_after) = strip_cwd_sentinel(&raw.stdout);
        if let Some(ref new_cwd) = cwd_after {
            if std::path::Path::new(new_cwd).is_dir() {
                *self.cwd.lock().unwrap_or_else(|e| e.into_inner()) = new_cwd.clone();
            }
        }
        let resolved_cwd = self
            .cwd
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace('\\', "/");

        Ok(SessionRunOutput {
            stdout: stdout_clean,
            stderr: raw.stderr,
            exit_code: raw.exit_code,
            timed_out: raw.timed_out,
            truncated: raw.truncated,
            cwd_after: resolved_cwd,
        })
    }
}

struct ShellState {
    sessions: RwLock<HashMap<u32, Arc<ShellSession>>>,
    bg: RwLock<HashMap<u32, Arc<BackgroundProc>>>,
    next_session_id: AtomicU32,
    next_bg_id: AtomicU32,
}

fn state() -> &'static ShellState {
    static S: OnceLock<ShellState> = OnceLock::new();
    S.get_or_init(|| ShellState {
        sessions: RwLock::new(HashMap::new()),
        bg: RwLock::new(HashMap::new()),
        next_session_id: AtomicU32::new(1),
        next_bg_id: AtomicU32::new(1),
    })
}

pub fn shell_session_open(args: &Value) -> Result<Value, String> {
    let cwd_arg = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let initial = match cwd_arg {
        Some(c) => {
            if !std::path::Path::new(c).is_dir() {
                return Err(format!("cwd is not a directory: {c}"));
            }
            c.to_string()
        }
        None => dirs::home_dir()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "/".to_string()),
    };
    let session = Arc::new(ShellSession {
        cwd: Mutex::new(initial),
        pristine: AtomicBool::new(true),
    });
    let id = state().next_session_id.fetch_add(1, Ordering::Relaxed);
    state().sessions.write().unwrap().insert(id, session);
    Ok(Value::Number(id.into()))
}

pub fn shell_session_run(args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or("shell_session_run: missing id")? as u32;
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd_hint = args.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
    let dur = timeout_dur(args);
    let session = state()
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    let out = session.run(command, cwd_hint, dur)?;
    to_value(&out)
}

pub fn shell_session_close(args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or("shell_session_close: missing id")? as u32;
    state().sessions.write().unwrap().remove(&id);
    Ok(Value::Null)
}

// ─── Background processes ──────────────────────────────────────────────────

struct BoundedRingBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    next_offset: u64,
    dropped: u64,
}
impl BoundedRingBuffer {
    fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            next_offset: 0,
            dropped: 0,
        }
    }
    fn push(&mut self, data: &[u8]) {
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        if data.len() >= self.cap {
            let keep_from = data.len() - self.cap;
            self.dropped = self
                .dropped
                .saturating_add((self.buf.len() + keep_from) as u64);
            self.buf.clear();
            self.buf.extend(&data[keep_from..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            for _ in 0..overflow {
                self.buf.pop_front();
            }
            self.dropped = self.dropped.saturating_add(overflow as u64);
        }
        self.buf.extend(data);
    }
    fn read_from(&self, since: u64) -> (Vec<u8>, u64, u64) {
        let oldest = self.next_offset.saturating_sub(self.buf.len() as u64);
        let start = since.max(oldest);
        let skip = (start - oldest) as usize;
        let bytes: Vec<u8> = self.buf.iter().copied().skip(skip).collect();
        (bytes, self.next_offset, self.dropped)
    }
}

struct BackgroundProc {
    command: String,
    cwd: Option<String>,
    started_at_ms: u64,
    child: Arc<SharedChild>,
    buffer: Mutex<BoundedRingBuffer>,
    exited: AtomicBool,
    exit_code: AtomicI32,
    exit_unknown: AtomicBool,
}

#[derive(Serialize)]
struct BackgroundLogResponse {
    bytes: String,
    next_offset: u64,
    dropped: u64,
    exited: bool,
    exit_code: Option<i32>,
}

#[derive(Serialize)]
struct BackgroundProcInfo {
    handle: u32,
    command: String,
    cwd: Option<String>,
    started_at_ms: u64,
    exited: bool,
    exit_code: Option<i32>,
}

impl BackgroundProc {
    fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        let (bytes, next_offset, dropped) = self
            .buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .read_from(since);
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }
    fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
        }
    }
}
impl Drop for BackgroundProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn spawn_background(command: String, cwd: Option<String>) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }
    let mut cmd = build_oneshot_command(&trimmed, cwd.as_deref());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let shared = SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?;
    let stdout_pipe = shared.take_stdout().ok_or("no stdout pipe")?;
    let stderr_pipe = shared.take_stderr().ok_or("no stderr pipe")?;
    let child = Arc::new(shared);

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(BackgroundProc {
        command: trimmed,
        cwd,
        started_at_ms,
        child,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
    });

    {
        let proc_ref = proc.clone();
        let mut pipe = stdout_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => proc_ref
                        .buffer
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(&buf[..n]),
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let mut pipe = stderr_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => proc_ref
                        .buffer
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(&buf[..n]),
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        thread::spawn(move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            proc_ref.exited.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}

pub fn shell_bg_spawn(args: &Value) -> Result<Value, String> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let proc = spawn_background(command, cwd)?;
    let id = state().next_bg_id.fetch_add(1, Ordering::Relaxed);
    state().bg.write().unwrap().insert(id, proc);
    Ok(Value::Number(id.into()))
}

pub fn shell_bg_logs(args: &Value) -> Result<Value, String> {
    let handle = args
        .get("handle")
        .and_then(|v| v.as_u64())
        .ok_or("shell_bg_logs: missing handle")? as u32;
    let since_offset = args
        .get("sinceOffset")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let proc = state()
        .bg
        .read()
        .unwrap()
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no background handle".to_string())?;
    to_value(&proc.read_logs(since_offset))
}

pub fn shell_bg_kill(args: &Value) -> Result<Value, String> {
    let handle = args
        .get("handle")
        .and_then(|v| v.as_u64())
        .ok_or("shell_bg_kill: missing handle")? as u32;
    if let Some(proc) = state().bg.read().unwrap().get(&handle).cloned() {
        let _ = proc.child.kill();
    }
    Ok(Value::Null)
}

pub fn shell_bg_list(_args: &Value) -> Result<Value, String> {
    let map = state().bg.read().unwrap();
    let mut out: Vec<BackgroundProcInfo> = map.iter().map(|(id, p)| p.info(*id)).collect();
    out.sort_by_key(|i| i.handle);
    to_value(&out)
}
