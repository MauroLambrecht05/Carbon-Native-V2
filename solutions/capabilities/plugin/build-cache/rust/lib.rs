//! Rust port of PluginBuildCache.ts. Skip `zig build --prefix .` when
//! nothing that affects a local plugin's output has changed since the last
//! successful build — mirrors carbon-build-cache
//! (solutions/capabilities/tooling/build-cache/rust), scoped to
//! carbon/plugins/local instead of the app's own source tree.
//!
//! `zig build` is a genuine no-op when nothing changed, but the
//! process-spawn + build-graph re-evaluation overhead is real (~600-800ms
//! measured on Windows against a single-local-plugin app). Deliberately does
//! NOT fingerprint the resolved zig binary — see PluginBuildCache.ts's own
//! doc comment for why (resolving zig costs ~180-190ms on its own, and
//! `carbon-launcher` only resolves it at all on an actual cache miss).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const CACHE_FILE_NAME: &str = ".carbon-plugin-cache.json";
const SKIP_DIRS: &[&str] = &["zig-cache", ".zig-cache", "zig-out"];

#[derive(Serialize, Deserialize)]
pub struct CacheEntry {
    pub key: String,
    #[serde(rename = "builtAt")]
    pub built_at: String,
}

/// Walk a directory recursively, return every file's absolute path
/// (sorted, for a stable hash). Mirrors `walkFiles`.
fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let abs = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(st) = entry.file_type() else { continue };
            if st.is_dir() {
                if SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                rec(&abs, out);
            } else if st.is_file() {
                out.push(abs);
            }
        }
    }
    rec(root, &mut out);
    out.sort();
    out
}

/// Mirrors `computePluginBuildKey`.
pub fn compute_plugin_build_key(carbon_dir: &Path, release: bool) -> String {
    let mut h = Sha256::new();
    h.update(format!("release={}\n", if release { "1" } else { "0" }));

    for name in ["manifest.toml", "build.zig", "build.zig.zon"] {
        let p = carbon_dir.join(name);
        let Ok(bytes) = fs::read(&p) else { continue };
        h.update(format!("F\t{name}\t"));
        h.update(&bytes);
        h.update("\n");
    }

    let local_dir = carbon_dir.join("plugins").join("local");
    if local_dir.exists() {
        for abs in walk_files(&local_dir) {
            let rel = abs.strip_prefix(carbon_dir).unwrap_or(&abs);
            let rel = rel.to_string_lossy().replace('\\', "/");
            h.update(format!("L\t{rel}\t"));
            if let Ok(bytes) = fs::read(&abs) {
                h.update(&bytes);
            }
            h.update("\n");
        }
    }

    let digest = hex::encode(h.finalize());
    digest[..32].to_string()
}

fn cache_path(bin_dir: &Path) -> PathBuf {
    bin_dir.join(CACHE_FILE_NAME)
}

/// Read the existing cache entry for a given carbon/bin/<os>/<arch>/ dir.
/// `None` if missing/corrupt.
pub fn read_plugin_build_cache(bin_dir: &Path) -> Option<CacheEntry> {
    let text = fs::read_to_string(cache_path(bin_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write the cache entry after a successful `zig build`. Best-effort — see
/// PluginBuildCache.ts's `writePluginBuildCache` doc comment for why a
/// failed write here must never fail the sync that already succeeded.
pub fn write_plugin_build_cache(bin_dir: &Path, key: &str) {
    let entry = CacheEntry {
        key: key.to_string(),
        built_at: now_iso8601(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&entry) {
        let _ = fs::write(cache_path(bin_dir), text);
    }
}

/// A minimal UTC ISO-8601 timestamp (`built_at` is for human inspection
/// only, per the TS original — no consumer parses it back).
fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // Days since epoch -> y/m/d via a plain civil-from-days algorithm
    // (Howard Hinnant's), so this crate doesn't need a chrono/time
    // dependency just to stamp a log-only field.
    let days = (secs / 86400) as i64;
    let (y, m, d) = civil_from_days(days);
    let rem = secs % 86400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
