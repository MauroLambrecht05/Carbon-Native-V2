// carbon-launcher — native `carbon run`/`carbon dev`. See Cargo.toml's own
// header comment for why this exists.
//
// Shape: check whether everything `run`/`dev` would need to do is already
// current (node_modules install-state, the runtime binary, the plugin-build
// cache, the bundle cache — all the SAME checks/files
// SyncPluginsUseCase.ts/BuildProjectUseCase.ts/InstallState.ts already use,
// ported so both implementations agree). If everything's current: spawn the
// runtime directly, no Bun involved at all. If ANYTHING needs real work
// (an install, a rebuild, `--clean`, `--force`) — delegate wholesale to the
// existing TypeScript `run.command.ts`/`dev.command.ts` via a `bun` child
// process, exactly as `carbon run`/`carbon dev` already behave today. This
// is deliberately NOT a rewrite of that logic: only the fast, common,
// nothing-changed path is native. The slow path is unchanged, just reached
// through one extra (cheap) process hop.
//
// `windows_subsystem = "windows"` (no-op outside Windows) — same fix, same
// reasoning as products/carbon/composition/mini.rs's matching attribute:
// without it, spawning this binary (specifically the `ensure-daemon`/
// `daemon` subcommands DaemonClient.ts invokes on every `carbon run`/`carbon
// dev` that misses a warm daemon) auto-allocates a visible console window
// regardless of stdio configuration — confirmed directly. Explicit stdio
// redirection (inherit, pipe, or null — all three are used somewhere in this
// binary's own call sites) still works correctly under this subsystem, so
// nothing about `run`/`dev`'s own console output is lost, only the
// auto-allocated window for the common (background helper) case.
#![windows_subsystem = "windows"]

#[cfg(windows)]
mod daemon;
#[cfg(windows)]
mod pipe;
mod spawn;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use spawn::Launched;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

fn main() {
    let t0 = Instant::now();
    let argv: Vec<String> = env::args().skip(1).collect();
    let code = match argv.first().map(String::as_str) {
        Some("run") => run_or_dev(&argv[1..], t0, false),
        Some("dev") => run_or_dev(&argv[1..], t0, true),
        #[cfg(windows)]
        Some("daemon") => match daemon::run_daemon() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("carbon-launcher: daemon failed: {e:#}");
                1
            }
        },
        // See daemon::ensure_daemon's doc comment for why this is a separate
        // subcommand rather than TypeScript spawning `daemon` directly.
        #[cfg(windows)]
        Some("ensure-daemon") => daemon::ensure_daemon(),
        _ => {
            eprintln!(
                "carbon-launcher: expected \"run\" or \"dev\" as the first argument \
                 (this binary is a fast path for `carbon run`/`carbon dev` only — \
                 every other subcommand still goes through the TypeScript CLI)"
            );
            2
        }
    };
    std::process::exit(code);
}

struct Args {
    project_dir: PathBuf,
    runtime_override: Option<String>,
    force: bool,
    verbose: bool,
    clean: bool,
    debug: bool,
}

/// Mirrors run.command.ts's/dev.command.ts's `parseArgs` — same flags, same
/// defaults. `--no-babel-cache` is intentionally not modeled here: it only
/// matters on the slow (delegated) path, where the original flag string is
/// forwarded to the TS CLI verbatim regardless of whether this parser
/// understands it.
fn parse_args(rest: &[String]) -> Args {
    let mut project_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut runtime_override = None;
    let mut force = false;
    let mut verbose = false;
    let mut clean = false;
    let mut debug = false;
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        match a {
            "--runtime" | "-r" => {
                i += 1;
                runtime_override = rest.get(i).cloned();
            }
            "--force" | "--no-cache" | "-f" => force = true,
            "--verbose" | "-V" => verbose = true,
            "--clean" => clean = true,
            "--debug" | "-d" => debug = true,
            _ if a.starts_with("--runtime=") => {
                runtime_override = Some(a["--runtime=".len()..].to_string());
            }
            _ if !a.starts_with('-') => {
                project_dir = fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
            }
            _ => {}
        }
        i += 1;
    }
    Args {
        project_dir,
        runtime_override,
        force,
        verbose,
        clean,
        debug,
    }
}

#[derive(Deserialize, Default)]
struct AppSection {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct RuntimeSection {
    backend: Option<String>,
    #[serde(default)]
    bytecode: bool,
}

#[derive(Deserialize, Default)]
struct CarbonToml {
    #[serde(default)]
    app: AppSection,
    #[serde(default)]
    runtime: RuntimeSection,
}

fn read_carbon_toml(project_dir: &Path) -> Option<CarbonToml> {
    let text = fs::read_to_string(project_dir.join("carbon.toml")).ok()?;
    basic_toml::from_str(&text).ok()
}

// ── node_modules install-state — port of InstallState.ts ──────────────────

fn install_key(project_dir: &Path) -> String {
    let mut h = Sha256::new();
    h.update("package.json\t");
    h.update(fs::read(project_dir.join("package.json")).unwrap_or_default());
    h.update("\n");
    for name in ["bun.lock", "bun.lockb"] {
        if let Ok(bytes) = fs::read(project_dir.join(name)) {
            h.update(format!("{name}\t"));
            h.update(&bytes);
            h.update("\n");
        }
    }
    hex::encode(h.finalize())[..32].to_string()
}

#[derive(Deserialize)]
struct InstallStamp {
    key: String,
}

fn node_modules_current(project_dir: &Path) -> bool {
    if !project_dir.join("package.json").exists() {
        return true; // no JS deps to install
    }
    let node_modules = project_dir.join("node_modules");
    if !node_modules.exists() {
        return false;
    }
    let Ok(text) = fs::read_to_string(node_modules.join(".carbon-install.json")) else {
        return false;
    };
    let Ok(stamp) = serde_json::from_str::<InstallStamp>(&text) else {
        return false;
    };
    stamp.key == install_key(project_dir)
}

// ── carbon root / runtime binary resolution — port of WorkspaceLayout.ts ──

/// `CARBON_ROOT` env override first, else search upward from this binary's
/// own location for the monorepo root marker — same two markers
/// `findWorkspaceRoot` uses, same reasoning (immune to this binary being
/// copied elsewhere, or the target/<profile>/ nesting changing depth).
fn carbon_root() -> PathBuf {
    if let Ok(over) = env::var("CARBON_ROOT") {
        return PathBuf::from(over);
    }
    let start = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let mut dir = start;
    loop {
        if dir.join("MODULE.bazel").exists()
            || dir.join(".config").join("tsconfig.base.json").exists()
        {
            return dir;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

fn crate_name_for_backend(backend: &str) -> &'static str {
    if backend == "blitz" {
        "carbon-blitz"
    } else {
        "carbon-mini"
    }
}

/// Only ever searches the `release` profile — the ONE profile `carbon run`/
/// `carbon dev` themselves ever build. See BuildProjectUseCase.ts's
/// `preferredProfile` fix: searching `dist` too (the shared default
/// `resolveBackendBinary` search order uses) meant a stale static-plugins
/// `dist` binary could silently shadow every future `release` rebuild
/// forever. This binary makes the same targeted choice natively.
pub(crate) fn resolve_runtime_binary(backend: &str) -> Option<PathBuf> {
    let exe_name = format!(
        "{}{}",
        crate_name_for_backend(backend),
        if cfg!(windows) { ".exe" } else { "" }
    );
    let p = carbon_root()
        .join(".tools")
        .join("orchestration")
        .join("bazel")
        .join("cargo")
        .join("target")
        .join("release")
        .join(exe_name);
    p.exists().then_some(p)
}

// ── plugin-build cache gate — port of SyncPluginsUseCase.ts's hit check ───

#[derive(Deserialize)]
struct PluginEntry {
    source: String,
    #[serde(default = "default_true")]
    enabled: bool,
}
fn default_true() -> bool {
    true
}

#[derive(Deserialize, Default)]
struct PluginManifestToml {
    #[serde(default)]
    plugins: HashMap<String, PluginEntry>,
}

/// Native target directory names — solutions/contracts/plugin/README.md's
/// canonical table, same one
/// solutions/capabilities/plugin/lifecycle/domain/value-objects/NativeTarget.ts
/// implements on the TS side. Every reader of carbon/bin/<os>/<arch>/ must
/// agree on these three strings exactly.
fn host_os_name() -> &'static str {
    match env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        other => other,
    }
}
fn host_arch_name() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        (_, "x86_64") => "x86_64",
        ("macos", "aarch64") => "arm64",
        (_, "aarch64") => "aarch64",
        (_, other) => other,
    }
}
fn host_ext() -> &'static str {
    match env::consts::OS {
        "windows" => "dll",
        "linux" => "so",
        "macos" => "dylib",
        _ => "so",
    }
}

/// True only when SyncPluginsUseCase.ts, run with `release: true` (what
/// `carbon run` always passes), would do NOTHING: every enabled vendor
/// plugin already staged, every enabled local plugin's artifact present,
/// and (if there's a build.zig at all) the plugin-build cache key matches.
fn plugins_current(project_dir: &Path) -> bool {
    let carbon_dir = project_dir.join("carbon");
    let manifest_path = carbon_dir.join("manifest.toml");
    if !manifest_path.exists() {
        return true; // no carbon/ at all — SyncPluginsUseCase no-ops too
    }
    let Ok(text) = fs::read_to_string(&manifest_path) else {
        return false;
    };
    let Ok(manifest) = basic_toml::from_str::<PluginManifestToml>(&text) else {
        return false;
    };
    let bin_dir = carbon_dir
        .join("bin")
        .join(host_os_name())
        .join(host_arch_name());
    let ext = host_ext();

    let vendor_staged = manifest.plugins.iter().all(|(name, e)| {
        !(e.enabled && e.source == "vendor") || bin_dir.join(format!("{name}.{ext}")).exists()
    });
    if !vendor_staged {
        return false;
    }

    if !carbon_dir.join("build.zig").exists() {
        return true;
    }

    let local_present = manifest.plugins.iter().all(|(name, e)| {
        !(e.enabled && e.source == "local") || bin_dir.join(format!("{name}.{ext}")).exists()
    });
    if !local_present {
        return false;
    }

    let key = carbon_plugin_build_cache::compute_plugin_build_key(&carbon_dir, true);
    carbon_plugin_build_cache::read_plugin_build_cache(&bin_dir).is_some_and(|c| c.key == key)
}

// ── bundle cache gate — port of buildProject's own cache check ────────────

fn bundle_current(
    project_dir: &Path,
    backend: &str,
    bytecode: bool,
    dev: bool,
    runtime_exe: Option<&Path>,
) -> bool {
    let key =
        carbon_build_cache::compute_cache_key(project_dir, backend, bytecode, dev, runtime_exe);
    let Some(cache) = carbon_build_cache::read_cache(project_dir) else {
        return false;
    };
    cache.key == key && carbon_build_cache::artifacts_exist(project_dir, &cache.artifacts)
}

// ── slow-path fallback: hand off to the existing TS CLI unchanged ─────────

/// `bun <repo>/products/carbon-cli/main.ts <subcommand> <rest>` — the exact
/// invocation the `carbon`/`carbon.cmd` wrapper already makes today.
/// Inherits stdio, so the user sees identical output to today's `carbon
/// run`/`carbon dev` for everything this binary didn't fast-path.
///
/// On Windows, `bun` is commonly an npm-installed shim (`bun.cmd`/`bun.ps1`
/// alongside the real `bun.exe` elsewhere) rather than a directly executable
/// image on PATH — confirmed directly (`Get-Command bun -All` on this
/// machine lists only `bun.cmd`/`bun.ps1`/a POSIX shell shim, no bare
/// `bun.exe`). `CreateProcess` (what `std::process::Command` uses) can't
/// execute a `.cmd` file as an image the way a shell's own command
/// resolution can — this is the SAME reasoning `NodeProcessRunner.ts`'s
/// `shell: true` existed for, still correct here for a genuinely bare PATH
/// name (as opposed to carbon-mini's already-resolved absolute path, which
/// never needed shell mediation — see `spawn.rs`'s module doc and tonight's
/// `isAbsolutePath` fix on the TS side for that distinction).
fn delegate_to_ts(subcommand: &str, rest: &[String]) -> i32 {
    let main_ts = carbon_root()
        .join("products")
        .join("carbon-cli")
        .join("main.ts");

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("bun");
        c
    } else {
        Command::new("bun")
    };
    cmd.arg(&main_ts).arg(subcommand).args(rest);

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("carbon-launcher: could not fall back to the TypeScript CLI ({e}) — is `bun` on PATH?");
            1
        }
    }
}

// ── the actual run/dev dispatch ────────────────────────────────────────────

fn run_or_dev(rest: &[String], t0: Instant, dev_mode: bool) -> i32 {
    let args = parse_args(rest);

    if args.clean {
        for rel in ["node_modules", "dist", ".carbon-cache", "carbon/bin"] {
            let p = args.project_dir.join(rel);
            if p.exists() {
                let _ = fs::remove_dir_all(&p);
            }
        }
    }

    let Some(cfg) = read_carbon_toml(&args.project_dir) else {
        // No parseable carbon.toml — this is exactly loadCarbonConfig's
        // failure case on the TS side (a real config error, not a "needs
        // rebuild" case), so let the TS CLI produce its normal, detailed
        // error message rather than duplicating that validation here.
        let subcommand = if dev_mode { "dev" } else { "run" };
        return delegate_to_ts(subcommand, rest);
    };
    let backend = args.runtime_override.clone().unwrap_or_else(|| {
        cfg.runtime
            .backend
            .clone()
            .unwrap_or_else(|| "mini".to_string())
    });
    let bytecode = cfg.runtime.bytecode;

    let runtime_exe = resolve_runtime_binary(&backend);
    let take_fast_path = !args.clean
        && !args.force
        && node_modules_current(&args.project_dir)
        && runtime_exe.is_some()
        && plugins_current(&args.project_dir)
        && bundle_current(
            &args.project_dir,
            &backend,
            bytecode,
            dev_mode,
            runtime_exe.as_deref(),
        );

    if !take_fast_path {
        let subcommand = if dev_mode { "dev" } else { "run" };
        return delegate_to_ts(subcommand, rest);
    }

    // ── FAST PATH: no Bun, no Node, from here on ───────────────────────
    let exe = runtime_exe.expect("checked by take_fast_path above");

    // Daemon first (Phase B): if a pre-warmed instance is available, it
    // skips the ~65-83ms OS process-creation cost the direct spawn below
    // still pays. Any daemon failure — unreachable, pool empty, stale —
    // falls straight through to that direct spawn; the daemon is a pure
    // optimization on top of the fast path, never a dependency of it.
    #[cfg(windows)]
    {
        let app_name = if cfg.app.name.is_empty() {
            "app"
        } else {
            cfg.app.name.as_str()
        };
        if let Some(code) = daemon::try_daemon(&args.project_dir, &backend, dev_mode, t0, app_name)
        {
            return code;
        }
    }

    if args.debug && env::var_os("CARBON_MINI_DEBUG").is_none() {
        env::set_var("CARBON_MINI_DEBUG", "1");
    }
    if !args.verbose && env::var_os("CARBON_NO_TIMING").is_none() {
        env::set_var("CARBON_NO_TIMING", "1");
    }

    let runtime_args: Vec<String> = if backend == "blitz" {
        vec![args
            .project_dir
            .join("dist")
            .join("bundle.js")
            .to_string_lossy()
            .to_string()]
    } else {
        vec![args.project_dir.to_string_lossy().to_string()]
    };

    let launched = match spawn::spawn_and_wait_for_visible(&exe, &runtime_args) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("carbon-launcher: failed to launch {}: {e:#}", exe.display());
            return 1;
        }
    };

    let mut child = match launched {
        Launched::ExitedEarly(code) => return code,
        Launched::Visible(child) => child,
    };

    eprintln!(
        "\u{2713} {} ready in {}ms",
        if cfg.app.name.is_empty() {
            "app"
        } else {
            cfg.app.name.as_str()
        },
        t0.elapsed().as_millis()
    );

    match child.wait() {
        Ok(status) => status.code().unwrap_or(0),
        Err(e) => {
            eprintln!("carbon-launcher: error waiting for runtime to exit: {e:#}");
            1
        }
    }
}
