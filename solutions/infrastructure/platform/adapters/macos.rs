// macOS-only host implementations. See carbon/platform/mod.rs. Shell
// command construction on macOS uses unix.rs unchanged — this file only
// holds behavior Finder needs that generic Unix doesn't.

use std::path::Path;
use std::process::Command;

/// Reveals `path` in Finder with the file highlighted. Fire-and-forget:
/// a failed spawn is silently ignored, matching the pre-extraction behavior.
pub fn reveal_in_file_manager(path: &Path) {
    let _ = Command::new("open").arg("-R").arg(path).spawn();
}
