// Clipboard OS integration, backing the `clipboard_*` ABI trampolines in
// abi/host_exports.rs (ABI 1.3). Previously a `carbon-os` adapter that
// installed `__cm_clipboard_*` directly onto the JS context — moved here so
// clipboard access goes through the `clipboard` plugin
// (products/carbon-sdk/clipboard) like every other optional OS capability,
// instead of being an always-on ambient global. The arboard usage itself is
// unchanged.

use anyhow::Result;
use arboard::Clipboard;
use std::sync::{Mutex, OnceLock};

fn clipboard() -> &'static Mutex<Option<Clipboard>> {
    static C: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Clipboard::new().ok()))
}

/// Empty string if no clipboard backend is available — matches the original
/// adapter's behavior (never an error for "no backend", only for a real
/// read failure on a backend that does exist).
pub fn read_text() -> Result<String> {
    let mut guard = clipboard().lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(c) => Ok(c.get_text()?),
        None => Ok(String::new()),
    }
}

pub fn write_text(text: &str) -> Result<()> {
    let mut guard = clipboard().lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(c) => Ok(c.set_text(text.to_string())?),
        None => Ok(()),
    }
}

/// arboard has no dedicated clear() — setting empty text is the same
/// observable behavior. Best-effort: a missing backend is a silent no-op,
/// same as the original.
pub fn clear() {
    let mut guard = clipboard().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = guard.as_mut() {
        let _ = c.set_text(String::new());
    }
}
