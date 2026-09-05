//! Rust port of BuildCache.ts's two-layer (content-hash-skip, then
//! directory-walk-skip) bundle cache key computation. Reads and writes the
//! EXACT SAME files a `carbon build`/`carbon plugin` TypeScript invocation
//! already uses (`dist/.carbon-cache.json`, `dist/.carbon-cache-stat.json`)
//! so a native `carbon run`/`carbon dev` and the TS pipeline agree on cache
//! hit/miss for the same project state — see `CACHE_SCHEMA_VERSION`'s own
//! doc comment for the one piece of the original TS design (a per-CLI-binary
//! fingerprint) that could NOT survive a second implementation existing, and
//! what replaced it.
//!
//! Every function here mirrors its BuildCache.ts namesake one-to-one —
//! same walk order, same tag scheme (F/W/P), same hash tab/newline framing —
//! so the two are easy to keep in lockstep by inspection, not just by trust.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const CACHE_FILE_NAME: &str = ".carbon-cache.json";
const STAT_SIDECAR_NAME: &str = ".carbon-cache-stat.json";

/// Bumped whenever hash-affecting logic changes in EITHER this crate or its
/// TypeScript counterpart's `CACHE_SCHEMA_VERSION`
/// (solutions/capabilities/tooling/bundling/infrastructure/BuildCache.ts).
/// Both MUST use the same value — a native `carbon run` and a TS
/// `carbon build` computing different keys for identical project state
/// means every switch between them forces a needless rebuild. This replaced
/// what used to be a fingerprint of the running CLI's OWN binary: that only
/// worked while exactly one tool ever computed this key. Bump this by hand,
/// in both files, whenever either implementation's cache-affecting logic
/// changes — an explicit, human-reviewed invalidation trigger instead of
/// two binaries silently drifting.
pub const CACHE_SCHEMA_VERSION: &str = "1";

const TRACKED_EXTS: &[&str] = &[
    ".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".svg", ".html", ".toml", ".json",
];
const SKIP_DIRS: &[&str] = &["node_modules", "dist", ".carbon-cache", "target", ".git"];
const ALWAYS_INCLUDE: &[&str] = &[
    "package.json",
    "carbon.toml",
    "tsconfig.json",
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
];

#[derive(Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    pub key: String,
    pub artifacts: Vec<String>,
    #[serde(rename = "builtAt")]
    pub built_at: String,
}

/// A walk's output: tracked files found, AND every directory successfully
/// listed — the latter is what lets `compute_cache_key` skip re-walking a
/// tree whose directories haven't changed. Mirrors BuildCache.ts's
/// `WalkResult`.
#[derive(Default)]
struct WalkResult {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}

/// Walk the project dir, return absolute paths of all tracked files plus
/// every directory actually descended into. Mirrors `walkSources`.
fn walk_sources(root: &Path) -> WalkResult {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    fn rec(dir: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            // Doesn't exist / unreadable — not recorded in `dirs`, so a
            // caller checking "does this remembered directory still have
            // the same mtime" correctly treats a vanished directory as a
            // change, not a silent pass.
            Err(_) => return,
        };
        dirs.push(dir.to_path_buf());
        for entry in entries.flatten() {
            let abs = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let st = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if st.is_dir() {
                if SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                if name.starts_with('.') {
                    continue; // .git, .vscode, .carbon-cache, …
                }
                rec(&abs, files, dirs);
            } else if st.is_file() {
                let ext = match name.rfind('.') {
                    Some(i) => &name[i..],
                    None => "",
                };
                if TRACKED_EXTS.contains(&ext) || ALWAYS_INCLUDE.contains(&name.as_ref()) {
                    files.push(abs);
                }
            }
        }
    }
    rec(root, &mut files, &mut dirs);
    sort_paths(&mut files);
    sort_paths(&mut dirs);
    WalkResult { files, dirs }
}

/// Sorts by the path's own string form (native separators preserved), NOT
/// `PathBuf`'s component-wise `Ord` — the two do not always agree (e.g. a
/// path with more components can sort before or after a lexicographically
/// later sibling depending on where the component boundary falls). Every
/// TS walker sorts a plain string array (`Array.prototype.sort`, UTF-16
/// code-unit order); files below are hashed in walk order, so a differing
/// sort here changes the digest even when the file SET is identical between
/// the two implementations — confirmed directly: this was the entire cause
/// of the Rust and TS ports computing different keys for byte-identical
/// project state before this fix. UTF-8 byte order and UTF-16 code-unit
/// order agree for ASCII paths (the only kind this needs to handle well —
/// same "good enough for what carbon actually generates" posture
/// `walkTsconfigPathAliases`'s own doc comment states).
fn sort_paths(paths: &mut [PathBuf]) {
    paths.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
}

#[derive(Deserialize, Default)]
struct PackageJson {
    name: Option<String>,
    dependencies: Option<HashMap<String, String>>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: Option<HashMap<String, String>>,
    #[serde(rename = "peerDependencies")]
    peer_dependencies: Option<HashMap<String, String>>,
    workspaces: Option<Vec<String>>,
}

fn read_package_json(dir: &Path) -> Option<PackageJson> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Walk every workspace dep transitively reachable from `consumer_dir`'s
/// `package.json` — `file:../path` and `workspace:*` specs, resolved the
/// same way `walkWorkspaceDeps` does (npm-registry specs are skipped; they
/// don't change between cache checks). Mirrors `walkWorkspaceDeps`.
fn walk_workspace_deps(consumer_dir: &Path) -> WalkResult {
    // Lazily build name -> dir by walking up to the monorepo root and
    // expanding its `workspaces` patterns. Only built when a `workspace:`
    // spec is actually encountered.
    let workspace_map = |consumer_dir: &Path| -> HashMap<String, PathBuf> {
        let mut map = HashMap::new();
        let mut root: Option<PathBuf> = None;
        let mut dir = consumer_dir.to_path_buf();
        loop {
            if let Some(pj) = read_package_json(&dir) {
                if pj.workspaces.as_ref().is_some_and(|w| !w.is_empty()) {
                    root = Some(dir.clone());
                    break;
                }
            }
            match dir.parent() {
                Some(p) if p != dir => dir = p.to_path_buf(),
                _ => break,
            }
        }
        let Some(root) = root else { return map };
        let Some(root_pj) = read_package_json(&root) else {
            return map;
        };
        for pat in root_pj.workspaces.unwrap_or_default() {
            if let Some(star) = pat.find('*') {
                let base = pat[..star].trim_end_matches(['/', '\\']);
                let base_dir = root.join(base);
                let Ok(entries) = fs::read_dir(&base_dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let d = entry.path();
                    if let Some(pj) = read_package_json(&d) {
                        if let Some(name) = pj.name {
                            map.insert(name, d);
                        }
                    }
                }
            } else {
                let d = root.join(&pat);
                if let Some(pj) = read_package_json(&d) {
                    if let Some(name) = pj.name {
                        map.insert(name, d);
                    }
                }
            }
        }
        map
    };

    let mut out_files = Vec::new();
    let mut out_dirs = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut name_map: Option<HashMap<String, PathBuf>> = None;

    fn rec(
        dir: &Path,
        visited: &mut HashSet<PathBuf>,
        out_files: &mut Vec<PathBuf>,
        out_dirs: &mut Vec<PathBuf>,
        name_map: &mut Option<HashMap<String, PathBuf>>,
        workspace_map: &dyn Fn(&Path) -> HashMap<String, PathBuf>,
        consumer_dir: &Path,
    ) {
        let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        if !visited.insert(canon) {
            return;
        }
        let Some(pj) = read_package_json(dir) else {
            return;
        };
        let mut all: HashMap<String, String> = HashMap::new();
        for m in [pj.dependencies, pj.dev_dependencies, pj.peer_dependencies]
            .into_iter()
            .flatten()
        {
            all.extend(m);
        }
        for (name, spec) in all {
            let dep_dir: Option<PathBuf> = if let Some(rest) = spec.strip_prefix("file:") {
                Some(dir.join(rest))
            } else if spec.starts_with("workspace:") {
                if name_map.is_none() {
                    *name_map = Some(workspace_map(consumer_dir));
                }
                name_map.as_ref().and_then(|m| m.get(&name)).cloned()
            } else {
                continue; // npm-registry deps don't change between cache checks
            };
            let Some(dep_dir) = dep_dir else { continue };
            if !dep_dir.exists() {
                continue;
            }
            let sub = walk_sources(&dep_dir);
            out_files.extend(sub.files);
            out_dirs.extend(sub.dirs);
            rec(
                &dep_dir,
                visited,
                out_files,
                out_dirs,
                name_map,
                workspace_map,
                consumer_dir,
            );
        }
    }

    rec(
        consumer_dir,
        &mut visited,
        &mut out_files,
        &mut out_dirs,
        &mut name_map,
        &workspace_map,
        consumer_dir,
    );

    dedup_sort(&mut out_files);
    dedup_sort(&mut out_dirs);
    WalkResult {
        files: out_files,
        dirs: out_dirs,
    }
}

fn dedup_sort(v: &mut Vec<PathBuf>) {
    sort_paths(v);
    v.dedup();
}

/// Walk every directory (or exact file) a scaffolded app's own
/// `tsconfig.json` `compilerOptions.paths` points at. Mirrors
/// `walkTsconfigPathAliases`. No `extends` support — see the TS original's
/// doc comment for why that's an accepted simplification, not an oversight.
fn walk_tsconfig_path_aliases(project_dir: &Path) -> WalkResult {
    let tsconfig_path = project_dir.join("tsconfig.json");
    let Ok(text) = fs::read_to_string(&tsconfig_path) else {
        return WalkResult::default();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return WalkResult::default();
    };
    let paths = json
        .get("compilerOptions")
        .and_then(|c| c.get("paths"))
        .and_then(|p| p.as_object());
    let Some(paths) = paths else {
        return WalkResult::default();
    };

    let mut out_files = Vec::new();
    let mut out_dirs = Vec::new();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    for targets in paths.values() {
        let Some(targets) = targets.as_array() else {
            continue;
        };
        for target in targets {
            let Some(target) = target.as_str() else {
                continue;
            };
            let trimmed = target.trim_end_matches('*');
            let resolved = resolve_path(project_dir, trimmed);
            let ext_matches = resolved
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e, "ts" | "tsx" | "js" | "jsx" | "mjs"));
            if ext_matches {
                out_files.push(resolved);
                continue;
            }
            if !seen_dirs.insert(resolved.clone()) {
                continue;
            }
            let sub = walk_sources(&resolved);
            out_files.extend(sub.files);
            out_dirs.extend(sub.dirs);
        }
    }
    dedup_sort(&mut out_files);
    dedup_sort(&mut out_dirs);
    WalkResult {
        files: out_files,
        dirs: out_dirs,
    }
}

/// `Path::join` treats an absolute `target` as replacing `base` entirely —
/// the same semantics `path.resolve(base, target)` has in Node, which is
/// what this mirrors.
fn resolve_path(base: &Path, target: &str) -> PathBuf {
    let t = Path::new(target);
    if t.is_absolute() {
        t.to_path_buf()
    } else {
        base.join(t)
    }
}

/// One tracked source file's identity for the cheap staleness pre-check —
/// NOT its content. `t` matches the F/W/P tag the content hash below tags
/// each file with; `p` is the same path string used there too.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct StatEntry {
    t: char, // 'F' | 'W' | 'P'
    p: String,
    s: i64,
    m: f64,
}

/// One directory the last full walk successfully listed.
#[derive(Clone, Serialize, Deserialize)]
struct DirEntry {
    p: String,
    m: f64,
}

#[derive(Serialize, Deserialize)]
struct StatSidecar {
    #[serde(rename = "sourceHash")]
    source_hash: String,
    stat: Vec<StatEntry>,
    dirs: Vec<DirEntry>,
}

fn stat_sidecar_path(project_dir: &Path) -> PathBuf {
    project_dir.join("dist").join(STAT_SIDECAR_NAME)
}

fn read_stat_sidecar(project_dir: &Path) -> Option<StatSidecar> {
    let text = fs::read_to_string(stat_sidecar_path(project_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Best-effort — see BuildCache.ts's `writeStatSidecar` doc comment for why
/// a failed write here must never fail the cache-key computation.
fn write_stat_sidecar(project_dir: &Path, entry: &StatSidecar) {
    if let Ok(text) = serde_json::to_string(entry) {
        let _ = fs::write(stat_sidecar_path(project_dir), text);
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(-1.0)
}

/// A failed stat (file vanished between the walk and here) reads as a
/// guaranteed-mismatch sentinel rather than erroring — the caller falls
/// through to the always-correct full content-hash path instead of failing
/// the whole cache-key computation over one racy file.
fn safe_stat_entry(t: char, p: &str, abs: &Path) -> StatEntry {
    match fs::metadata(abs) {
        Ok(meta) => StatEntry {
            t,
            p: p.to_string(),
            s: meta.len() as i64,
            m: mtime_ms(&meta),
        },
        Err(_) => StatEntry {
            t,
            p: p.to_string(),
            s: -1,
            m: -1.0,
        },
    }
}

fn safe_dir_mtime(p: &Path) -> f64 {
    fs::metadata(p).map(|m| mtime_ms(&m)).unwrap_or(-1.0)
}

/// True only if EVERY directory the last full walk descended into still has
/// the exact mtime it had then — see BuildCache.ts's `dirsUnchanged` doc
/// comment for the full reasoning (adding/removing/renaming a file always
/// bumps its immediate parent directory's mtime).
fn dirs_unchanged(dirs: &[DirEntry]) -> bool {
    if dirs.is_empty() {
        return false;
    }
    dirs.iter().all(|d| safe_dir_mtime(Path::new(&d.p)) == d.m)
}

/// True unless `package.json`/`tsconfig.json` — anywhere in the tracked
/// set — changed. See BuildCache.ts's `structuralFilesUnchanged` doc
/// comment: these two drive WHICH directories get discovered in the first
/// place, a gap directory-mtime evidence on already-known directories can
/// never close on its own.
fn structural_files_unchanged(project_dir: &Path, stat: &[StatEntry]) -> bool {
    for e in stat {
        let base = e.p.rsplit('/').next().unwrap_or(&e.p);
        if base != "package.json" && base != "tsconfig.json" {
            continue;
        }
        let abs = if e.t == 'F' {
            project_dir.join(&e.p)
        } else {
            PathBuf::from(&e.p)
        };
        let cur = safe_stat_entry(e.t, &e.p, &abs);
        if cur.s != e.s || cur.m != e.m {
            return false;
        }
    }
    true
}

fn to_forward_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Compute the sha256 cache key — see this crate's module doc comment for
/// the two-layer staleness pre-check design (identical to BuildCache.ts's
/// `computeCacheKey`, which documents both layers in full).
pub fn compute_cache_key(
    project_dir: &Path,
    backend: &str,
    bytecode: bool,
    dev: bool,
    runtime_exe: Option<&Path>,
) -> String {
    let mut h = Sha256::new();
    h.update(format!("backend={backend}\n"));
    h.update(format!("bytecode={}\n", if bytecode { "1" } else { "0" }));
    if dev {
        h.update("dev=1\n");
    }

    // Layer 2: try to skip the walk itself first.
    let sidecar = read_stat_sidecar(project_dir);
    let can_skip_walk = sidecar.as_ref().is_some_and(|s| {
        dirs_unchanged(&s.dirs) && structural_files_unchanged(project_dir, &s.stat)
    });

    struct Tracked {
        t: char,
        p: String,
        abs: PathBuf,
    }

    let (tracked, current_dirs): (Vec<Tracked>, Vec<DirEntry>) = if can_skip_walk {
        let sidecar = sidecar.as_ref().unwrap();
        let tracked = sidecar
            .stat
            .iter()
            .map(|e| Tracked {
                t: e.t,
                p: e.p.clone(),
                abs: if e.t == 'F' {
                    project_dir.join(&e.p)
                } else {
                    PathBuf::from(&e.p)
                },
            })
            .collect();
        (tracked, sidecar.dirs.clone())
    } else {
        let files_w = walk_sources(project_dir);
        let dep_w = walk_workspace_deps(project_dir);
        let alias_w = walk_tsconfig_path_aliases(project_dir);

        let mut tracked = Vec::new();
        for abs in &files_w.files {
            let rel = abs.strip_prefix(project_dir).unwrap_or(abs).to_path_buf();
            tracked.push(Tracked {
                t: 'F',
                p: to_forward_slash(&rel),
                abs: abs.clone(),
            });
        }
        for abs in &dep_w.files {
            tracked.push(Tracked {
                t: 'W',
                p: to_forward_slash(abs),
                abs: abs.clone(),
            });
        }
        for abs in &alias_w.files {
            tracked.push(Tracked {
                t: 'P',
                p: to_forward_slash(abs),
                abs: abs.clone(),
            });
        }

        let mut dir_map: HashMap<PathBuf, f64> = HashMap::new();
        for d in files_w
            .dirs
            .iter()
            .chain(dep_w.dirs.iter())
            .chain(alias_w.dirs.iter())
        {
            dir_map
                .entry(d.clone())
                .or_insert_with(|| safe_dir_mtime(d));
        }
        let mut current_dirs: Vec<DirEntry> = dir_map
            .into_iter()
            .map(|(p, m)| DirEntry {
                p: to_forward_slash(&p),
                m,
            })
            .collect();
        current_dirs.sort_by(|a, b| a.p.cmp(&b.p));
        (tracked, current_dirs)
    };

    // Layer 1: skip the CONTENT hash when every tracked file's own stat
    // still matches — independent of, and always re-checked regardless of,
    // whether layer 2 skipped the walk above.
    let current_stat: Vec<StatEntry> = tracked
        .iter()
        .map(|f| safe_stat_entry(f.t, &f.p, &f.abs))
        .collect();

    let source_hash = if sidecar.as_ref().is_some_and(|s| s.stat == current_stat) {
        sidecar.unwrap().source_hash
    } else {
        let mut sh = Sha256::new();
        for f in &tracked {
            sh.update(format!("{}\t{}\t", f.t, f.p));
            if let Ok(bytes) = fs::read(&f.abs) {
                sh.update(&bytes);
            }
            sh.update("\n");
        }
        let source_hash = hex::encode(sh.finalize());
        write_stat_sidecar(
            project_dir,
            &StatSidecar {
                source_hash: source_hash.clone(),
                stat: current_stat,
                dirs: current_dirs,
            },
        );
        source_hash
    };
    h.update(format!("SRC\t{source_hash}\n"));

    // Runtime binary fingerprint.
    if let Some(exe) = runtime_exe {
        if let Ok(meta) = fs::metadata(exe) {
            h.update(format!("RT\t{}\t{:.0}\n", meta.len(), mtime_ms(&meta)));
        }
    }

    // Schema fingerprint — see CACHE_SCHEMA_VERSION's own doc comment.
    h.update(format!("SCHEMA\t{CACHE_SCHEMA_VERSION}\n"));

    let digest = hex::encode(h.finalize());
    digest[..32].to_string()
}

/// Read the existing cache entry (if any). `None` if missing/corrupt.
pub fn read_cache(project_dir: &Path) -> Option<CacheEntry> {
    let text = fs::read_to_string(project_dir.join("dist").join(CACHE_FILE_NAME)).ok()?;
    serde_json::from_str(&text).ok()
}

/// True if ALL listed artifacts still exist on disk.
pub fn artifacts_exist(project_dir: &Path, artifacts: &[String]) -> bool {
    artifacts.iter().all(|rel| project_dir.join(rel).exists())
}
