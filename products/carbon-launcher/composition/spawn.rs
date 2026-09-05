// Spawn carbon-mini (or carbon-blitz) directly — no shell wrapper, no
// Bun/Node in between — and wait for the SAME `[carbon-mini] window-visible`
// marker on stderr that `startAndWaitForWindowVisible`
// (solutions/infrastructure/process/adapters/NodeProcessRunner.ts) already
// watches for, so "ready" printed here means the same thing it means there:
// the runtime actually showed something on screen, not "the process was
// spawned".

use anyhow::Result;
use std::io::BufRead;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) const WINDOW_VISIBLE_MARKER: &str = "[carbon-mini] window-visible";
/// Same default as startAndWaitForWindowVisible's TS twin — a backend
/// without the marker (blitz doesn't have one) or a launch that never shows
/// a window must not hang `carbon run` forever waiting for a signal that
/// will never come.
const VISIBLE_TIMEOUT: Duration = Duration::from_millis(8000);

/// Outcome of the "wait for visible" phase — the caller (main.rs) decides
/// what "ready" means and when to print it, and separately owns waiting for
/// the child's eventual exit; this function's only job is the marker race.
pub enum Launched {
    /// Marker seen, or the timeout elapsed with the child still running —
    /// either way, something is (probably) on screen now. Caller owns
    /// `child` from here: forward Ctrl-C is automatic (see module doc),
    /// so the caller just needs to `wait()` on it eventually.
    Visible(Child),
    /// The child exited before ever showing anything.
    ExitedEarly(i32),
}

/// Spawns `exe`, forwards its stderr live (matches `stdio: "inherit"` for
/// every line except the marker, which is swallowed) for the FULL lifetime
/// of the process — not just until the marker arrives, since later output
/// (an app's own console logging, a later verbose timing line) must not go
/// missing just because "ready" already printed once — and returns once
/// either the marker arrives, the timeout elapses, or the child exits,
/// whichever comes first.
pub fn spawn_and_wait_for_visible(exe: &Path, args: &[String]) -> Result<Launched> {
    let mut child = Command::new(exe)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()?;

    let stderr = child.stderr.take().expect("stderr was piped");
    let visible = Arc::new(AtomicBool::new(false));
    let visible_writer = visible.clone();

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().map_while(std::result::Result::ok) {
            if line.trim() == WINDOW_VISIBLE_MARKER {
                visible_writer.store(true, Ordering::SeqCst);
                continue;
            }
            eprintln!("{line}");
        }
        // The reader loop above ends when the child's stderr closes (i.e.
        // the child exited) — nothing further to forward past that point.
    });

    let start = Instant::now();
    loop {
        if visible.load(Ordering::SeqCst) {
            return Ok(Launched::Visible(child));
        }
        if let Some(status) = child.try_wait()? {
            return Ok(Launched::ExitedEarly(status.code().unwrap_or(1)));
        }
        if start.elapsed() >= VISIBLE_TIMEOUT {
            return Ok(Launched::Visible(child));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
