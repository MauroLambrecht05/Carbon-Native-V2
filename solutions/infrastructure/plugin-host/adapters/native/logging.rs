// Structured native logging to a file, with size-based rotation — backs
// the `log_write` ABI trampoline in abi/host_exports.rs (ABI 1.12).
//
// FORMAT: one JSON object per line (JSONL) — `{"ts":"<RFC3339>","level":
// "info","msg":"..."}` — machine-parseable without a schema negotiation,
// same reasoning every other structured-logging tool picks this shape.
//
// ROTATION: when the file would exceed `MAX_BYTES`, it's renamed to
// `<path>.1` (overwriting any previous `.1`) and a fresh file started —
// one backup, not a numbered chain. Simple and sufficient for a desktop
// app's own diagnostic log, not a production log-aggregation pipeline.
//
// STATE: a small in-process cache of open file handles + running byte
// counts, keyed by resolved path, behind one `Mutex` — same "coarser
// than per-file locking, but this call is already synchronous/blocking
// from the JS thread's perspective" reasoning as sqlite.rs's connection
// cache.

use anyhow::Result;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

struct LogFile {
    file: File,
    written: u64,
}

static LOG_FILES: Mutex<Option<HashMap<String, LogFile>>> = Mutex::new(None);

fn open_for_append(path: &str) -> Result<(File, u64)> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let written = file.metadata()?.len();
    Ok((file, written))
}

/// RFC3339 UTC timestamp, hand-formatted — not worth a `time`/`chrono`
/// dependency for one line of arithmetic on `SystemTime`.
fn rfc3339_now() -> String {
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    // Days since epoch -> proleptic Gregorian date. Standard civil-from-days
    // algorithm (Howard Hinnant's, widely used for exactly this — no
    // dependency needed for a calculation this well-established).
    let days = (secs / 86_400) as i64;
    let rem_secs = secs % 86_400;
    let (hh, mm, ss) = (rem_secs / 3600, (rem_secs % 3600) / 60, rem_secs % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

pub fn write_line(path: &str, level: &str, message: &str) -> Result<()> {
    let mut guard = LOG_FILES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);

    if !map.contains_key(path) {
        let (file, written) = open_for_append(path)?;
        map.insert(path.to_string(), LogFile { file, written });
    }
    let entry = map.get_mut(path).expect("just inserted or already present");

    let line = format!(
        "{{\"ts\":\"{}\",\"level\":\"{}\",\"msg\":\"{}\"}}\n",
        rfc3339_now(),
        json_escape(level),
        json_escape(message)
    );

    if entry.written + line.len() as u64 > MAX_BYTES {
        // Rotate: drop the open handle, rename to `.1` (replacing any
        // previous backup), start fresh.
        drop(map.remove(path));
        let backup = format!("{path}.1");
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(path, &backup);
        let (file, _) = open_for_append(path)?;
        map.insert(path.to_string(), LogFile { file, written: 0 });
    }

    let entry = map.get_mut(path).expect("just inserted or already present");
    entry.file.write_all(line.as_bytes())?;
    entry.written += line.len() as u64;
    Ok(())
}
