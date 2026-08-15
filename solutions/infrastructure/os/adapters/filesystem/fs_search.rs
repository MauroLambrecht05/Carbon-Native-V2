// fs_grep / fs_glob / fs_search / list_subdirs — invoke-channel commands
// ported from the app's original Tauri backend (see
// examples/terax-ai-tauri-ref/src-tauri/src/modules/fs/{grep,search,tree}.rs).
// Gitignore-aware parallel walking via the `ignore` crate (ripgrep's own
// walker), regex search via `grep-regex`/`grep-searcher`, glob matching
// via `globset` — real ripgrep semantics, not a hand-rolled walker.
//
// The original commands took a `workspace: Option<WorkspaceEnv>` arg to
// transparently redirect into a WSL distro's filesystem (`\\wsl.localhost\...`).
// This port has no WSL bridge yet (`wsl_list_distros` is a stub that always
// returns an empty list — see invoke.rs — so the frontend can never actually
// select a WSL workspace), so `workspace` is accepted but ignored here: every
// path is resolved literally against the local filesystem.

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;
const MAX_SCANNED: usize = 50_000;

/// Directory names pruned unconditionally — dominate scan time on roots
/// with no .gitignore (e.g. searching from $HOME).
const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

fn to_canon(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("bad glob {p:?}: {e}"))?;
        b.add(g);
    }
    Ok(Some(b.build().map_err(|e| format!("globset build: {e}"))?))
}

pub fn fs_grep(args: &Value) -> Result<Value, String> {
    let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let root = args.get("root").and_then(|v| v.as_str()).unwrap_or("");
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let case_insensitive = args
        .get("caseInsensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cap = args
        .get("maxResults")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);
    let glob_patterns: Vec<String> = args
        .get("glob")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive)
        .line_terminator(Some(b'\n'))
        .build(pattern)
        .map_err(|e| format!("bad regex: {e}"))?;
    let globs = build_globset(&glob_patterns)?;

    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build_parallel();

    let hits: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    walker.run(|| {
        let matcher = matcher.clone();
        let globs = globs.clone();
        let hits = hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.to_path_buf();

        Box::new(move |dent_res| {
            if truncated.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(dent) = dent_res else {
                return WalkState::Continue;
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let Ok(rel_path) = path.strip_prefix(&root_path) else {
                return WalkState::Continue;
            };
            let rel = to_canon(rel_path);
            if let Some(set) = globs.as_ref() {
                if !set.is_match(&rel) {
                    return WalkState::Continue;
                }
            }
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }
            scanned.fetch_add(1, Ordering::Relaxed);

            let abs = to_canon(path);
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();
            let _ = searcher.search_path(
                &matcher,
                path,
                UTF8(|line_num, text| {
                    let line_text = text.trim_end_matches('\n').to_string();
                    let mut guard = hits.lock().unwrap_or_else(|e| e.into_inner());
                    if guard.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    let mut obj = serde_json::Map::new();
                    obj.insert("path".into(), Value::String(abs.clone()));
                    obj.insert("rel".into(), Value::String(rel.clone()));
                    obj.insert("line".into(), Value::Number(line_num.into()));
                    obj.insert("text".into(), Value::String(line_text));
                    guard.push(Value::Object(obj));
                    Ok(true)
                }),
            );
            WalkState::Continue
        })
    });

    let final_hits = Arc::try_unwrap(hits)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    out.insert("hits".into(), Value::Array(final_hits));
    out.insert(
        "truncated".into(),
        Value::Bool(truncated.load(Ordering::Relaxed)),
    );
    out.insert(
        "files_scanned".into(),
        Value::Number(scanned.load(Ordering::Relaxed).into()),
    );
    Ok(Value::Object(out))
}

pub fn fs_glob(args: &Value) -> Result<Value, String> {
    let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let root = args.get("root").and_then(|v| v.as_str()).unwrap_or("");
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = args
        .get("maxResults")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(500)
        .clamp(1, HARD_MAX_RESULTS);

    let glob = Glob::new(pattern).map_err(|e| format!("bad glob: {e}"))?;
    let mut gb = GlobSetBuilder::new();
    gb.add(glob);
    let set = gb.build().map_err(|e| format!("globset build: {e}"))?;

    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut hits: Vec<Value> = Vec::new();
    let mut truncated = false;
    for dent in walker.flatten() {
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        let Ok(rel_path) = path.strip_prefix(root_path) else {
            continue;
        };
        let rel = to_canon(rel_path);
        if !set.is_match(&rel) {
            continue;
        }
        let mut obj = serde_json::Map::new();
        obj.insert("path".into(), Value::String(to_canon(path)));
        obj.insert("rel".into(), Value::String(rel));
        hits.push(Value::Object(obj));
    }

    let mut out = serde_json::Map::new();
    out.insert("hits".into(), Value::Array(hits));
    out.insert("truncated".into(), Value::Bool(truncated));
    Ok(Value::Object(out))
}

pub fn fs_search(args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if query.is_empty() {
        let mut out = serde_json::Map::new();
        out.insert("hits".into(), Value::Array(vec![]));
        out.insert("truncated".into(), Value::Bool(false));
        return Ok(Value::Object(out));
    }
    let root = args.get("root").and_then(|v| v.as_str()).unwrap_or("");
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(200)
        .min(1000);
    let show_hidden = args
        .get("showHidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut out_hits: Vec<Value> = Vec::with_capacity(cap.min(64));
    let mut scanned: usize = 0;
    let mut truncated = false;

    let walker = WalkBuilder::new(root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .filter_entry(|dent| {
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    // (rel, name_matches) collected first so we can rank after the walk.
    let mut ranked: Vec<(Value, bool, usize)> = Vec::new();
    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        if ranked.len() >= cap {
            truncated = true;
            break;
        }
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let Ok(rel_path) = path.strip_prefix(root_path) else {
            continue;
        };
        let rel = to_canon(rel_path);
        if !rel.to_lowercase().contains(&query) {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name_matches = name.to_lowercase().contains(&query);
        let mut obj = serde_json::Map::new();
        obj.insert("path".into(), Value::String(to_canon(path)));
        obj.insert("rel".into(), Value::String(rel.clone()));
        obj.insert("name".into(), Value::String(name));
        obj.insert("is_dir".into(), Value::Bool(is_dir));
        ranked.push((Value::Object(obj), name_matches, rel.len()));
    }
    // Rank: filename matches first, then shorter relative paths.
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    out_hits.extend(ranked.into_iter().map(|(v, _, _)| v));

    let mut out = serde_json::Map::new();
    out.insert("hits".into(), Value::Array(out_hits));
    out.insert("truncated".into(), Value::Bool(truncated));
    Ok(Value::Object(out))
}

/// Lists immediate subdirectories of `path` — used by the cwd breadcrumb
/// dropdown. Symlinks to directories are included (matches shell `cd`
/// semantics). Hidden entries are filtered by dot-prefix only.
pub fn list_subdirs(args: &Value) -> Result<Value, String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let show_hidden = args
        .get("showHidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    let mut dirs: Vec<String> = read
        .filter_map(Result::ok)
        .filter(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_symlink() => std::fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false),
            _ => false,
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| show_hidden || !name.starts_with('.'))
        .collect();
    dirs.sort_by_key(|a| a.to_lowercase());
    Ok(Value::Array(dirs.into_iter().map(Value::String).collect()))
}
