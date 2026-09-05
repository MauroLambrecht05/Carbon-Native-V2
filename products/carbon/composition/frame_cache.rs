// First-frame screenshot cache: on a matching hit, the window shows real-
// looking content within the same ~20-30ms window/surface creation already
// costs, instead of waiting for font-load + JS-runtime-init + bundle-eval +
// layout + paint (measured 250-450ms+ on a real app — see the perf
// investigation this was born from). The real pipeline still runs afterward
// completely unmodified; it naturally overwrites the cached bitmap with
// fresh content on its own first real paint (see mini.rs's call site comment
// for why no other code needed to change for that swap to just happen).
//
// Cache key: the CLI's own JS-bundle content hash (read straight out of
// dist/.carbon-cache.json — no reason to re-hash the same inputs a second
// time with different code) plus physical width/height, DPI scale, and OS
// theme. Any mismatch is a cache miss — a blank-then-real window beats a
// wrong-sized or wrong-themed stale frame flashing before the real one
// arrives. Payload: raw RGBA8 premultiplied bytes (tiny_skia::Pixmap's own
// format — see mini.rs/run_loop.rs's call sites), LZ4-compressed the same
// way the embedded fonts are (already a dependency, decompresses in low
// single-digit ms even for a multi-MB frame).
//
// Storage: <project_dir>/dist/.carbon-frame-cache/<key>.rgba.lz4 — colocated
// with the CLI's own bundle cache so `carbon run --clean`/`carbon dev`
// wiping dist/ invalidates this for free, same reasoning as
// PluginBuildCache.ts's cache file living beside the artifacts it guards.
// `save` prunes every OTHER file in that directory first: a `carbon dev`
// edit loop changes the bundle hash on every save, so without pruning this
// directory would grow one file per edit forever with the old entries never
// reachable again (the bundle hash essentially never repeats once you've
// moved past it).

use std::io;
use std::path::{Path, PathBuf};

fn cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("dist").join(".carbon-frame-cache")
}

/// The CLI's own bundle content-hash key (BuildCache.ts's computeCacheKey,
/// written to dist/.carbon-cache.json's "key" field). `None` if the file is
/// missing (nothing built yet) or unreadable/malformed — callers treat that
/// as "no key available", i.e. skip the frame cache entirely rather than
/// key off something unstable.
fn bundle_key(project_dir: &Path) -> Option<String> {
    let path = project_dir.join("dist").join(".carbon-cache.json");
    let text = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("key")?.as_str().map(|s| s.to_string())
}

/// Filename stem for one (bundle, size, dpi, theme) combination. The bundle
/// key is always the FIRST path segment (before the first `_`) — `save`'s
/// pruning step relies on that to recognize "belongs to the current build"
/// without re-deriving the whole key.
fn frame_key(bundle_key: &str, w: u32, h: u32, scale: f32, theme: &str) -> String {
    // `scale` as raw bits, not a formatted float: exact equality on the
    // f32 tao actually handed us, no locale/precision formatting drift.
    format!("{bundle_key}_{w}x{h}_{:08x}_{theme}", scale.to_bits())
}

fn cache_path(project_dir: &Path, key: &str) -> PathBuf {
    cache_dir(project_dir).join(format!("{key}.rgba.lz4"))
}

/// Load a cached first frame for this exact (bundle content, window size,
/// DPI scale, theme). Returns raw RGBA8 premultiplied bytes, `w * h * 4`
/// long, ready to hand straight to `carbon_paint::blit_to_buffer` via a
/// `Canvas` — or `None` on any kind of miss (no prior cache, size/theme
/// changed, bundle edited, corrupt file). A miss is always silent and
/// non-fatal: this is a pure speed optimization, never a correctness path.
pub fn load(project_dir: &Path, w: u32, h: u32, scale: f32, theme: &str) -> Option<Vec<u8>> {
    let bkey = bundle_key(project_dir)?;
    let key = frame_key(&bkey, w, h, scale, theme);
    let compressed = std::fs::read(cache_path(project_dir, &key)).ok()?;
    let decompressed = lz4_flex::block::decompress_size_prepended(&compressed).ok()?;
    let expected = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
    if decompressed.len() != expected {
        // Stale/corrupt — a size mismatch here would misinterpret bytes as
        // pixels (or panic on a short copy_from_slice), so treat it as an
        // unconditional miss rather than trying to salvage a partial frame.
        return None;
    }
    Some(decompressed)
}

/// Save the just-painted real first frame for the NEXT launch. Best-effort:
/// any I/O failure here must never affect the app that's already running
/// and already visible (same posture as PluginBuildCache.ts's writeCache) —
/// the only cost of losing this write is the next launch not getting a
/// cache hit, same as if this file were deleted by hand.
pub fn save(project_dir: &Path, w: u32, h: u32, scale: f32, theme: &str, rgba: &[u8]) {
    let Some(bkey) = bundle_key(project_dir) else {
        return;
    };
    let dir = cache_dir(project_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    prune_other_bundles(&dir, &bkey);
    let key = frame_key(&bkey, w, h, scale, theme);
    let compressed = lz4_flex::block::compress_prepend_size(rgba);
    let _ = std::fs::write(cache_path(project_dir, &key), compressed);
}

/// Remove every cached frame NOT belonging to `bkey` — see the module doc
/// comment for why (unbounded growth across a `carbon dev` edit loop
/// otherwise). Best-effort: a failed removal just leaves one extra stale
/// file around, never a correctness problem (stale entries are never
/// matched by `load`'s exact bundle-key comparison, they're just untidy).
fn prune_other_bundles(dir: &Path, bkey: &str) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let prefix = format!("{bkey}_");
    for entry in entries.filter_map(|e: io::Result<_>| e.ok()) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
