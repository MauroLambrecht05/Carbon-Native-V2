// Introspection over the startup first-frame warm-start cache — backs
// the `framecache_stats`/`framecache_clear` ABI trampolines in
// abi/host_exports.rs (ABI 1.23). The cache itself lives entirely in
// `products/carbon/composition/frame_cache.rs` (mini-backend only,
// `dist/.carbon-frame-cache/`); this module does NOT read or write that
// cache's actual bitmap data — it only (a) records the hit/miss fact the
// composition root already computed at startup via `record_hit`, so a
// LATER plugin call can read it, and (b) recomputes the SAME cache
// directory path independently for `clear`, the same "duplicated rather
// than shared, each side is independently built" reasoning printing.rs's
// `resolvePath` documents.
//
// PLATFORM: none — plain file I/O, works everywhere. `hit` is always
// `false` on the blitz backend, which never calls `record_hit` at all
// (it has no frame cache) — not a failure, just not applicable there.

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static HIT: OnceLock<AtomicBool> = OnceLock::new();

/// Called once by the composition root (mini.rs) right after its own
/// `frame_cache::load(...)` call resolves, hit or miss. Never called at
/// all on a backend with no frame cache (blitz) — `stats()` then reports
/// `hit: false` by simple absence, which is the correct answer there too.
pub fn record_hit(hit: bool) {
    HIT.get_or_init(|| AtomicBool::new(false))
        .store(hit, Ordering::SeqCst);
}

pub fn stats() -> Result<String> {
    let hit = HIT.get().map(|b| b.load(Ordering::SeqCst)).unwrap_or(false);
    Ok(format!("{{\"hit\":{hit}}}"))
}

pub fn clear(project_dir: &str) -> Result<()> {
    let dir = std::path::Path::new(project_dir)
        .join("dist")
        .join(".carbon-frame-cache");
    // Not-found is success (nothing to clear), matching frame_cache.rs's
    // own "a miss/failure here is never a correctness problem" posture.
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
