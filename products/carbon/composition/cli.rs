// Parsing argv and dispatching to the build-time tool modes
// (--compile-bundle, --snapshot-spike, --snapshot-build) before the runtime
// composes itself for a launch.
//
// Everything here runs before any window / softbuffer / JS-runtime setup —
// a build-time invocation exits without paying for (or risking) any of it.

use super::*;

/// What `resolve` found: either a build-time mode already ran and the
/// process should exit with this `Result`, or the normal launch path should
/// continue with these parsed values.
pub(crate) enum Outcome {
    Exit(Result<()>),
    Run(ParsedArgs),
}

/// The subset of argv that survives past the build-time dispatch and is
/// still needed once the runtime starts composing a window.
pub(crate) struct ParsedArgs {
    pub(crate) dev_mode: bool,
    pub(crate) project_dir: PathBuf,
    pub(crate) window_opts_json: String,
}

/// Parse argv, dispatch build-time tool modes, install the
/// `CARBON_TEST_EXIT_MS` watchdog, and resolve the project directory +
/// window flags for a normal launch.
pub(crate) fn resolve() -> Result<Outcome> {
    let args: Vec<String> = std::env::args().collect();

    // Build-time mode: compile a JS bundle to QuickJS bytecode and exit.
    if args.len() >= 4 && args[1] == "--compile-bundle" {
        return Ok(Outcome::Exit(compile_bundle(&args[2], &args[3])));
    }

    // Snapshot spike (feature-gated proof of mechanism, isolated from startup):
    //   --snapshot-spike <build|restore> <snapshot-path> [bundle-or-probe.js]
    #[cfg(all(feature = "snapshot", windows))]
    if args.len() >= 4 && args[1] == "--snapshot-spike" {
        return Ok(Outcome::Exit(snapshot_spike(
            &args[2],
            &args[3],
            args.get(4).map(|s| s.as_str()),
        )));
    }

    // Build-time mode: produce a startup heap snapshot for an app.
    //   --snapshot-build <project-dir>
    // Dispatched on ANY build (not just feature builds) so the CLI can call it
    // unconditionally — a runtime without the `snapshot` feature just exits
    // cleanly instead of mistaking the flag for a project dir and launching.
    if args.len() >= 3 && args[1] == "--snapshot-build" {
        #[cfg(all(feature = "snapshot", windows))]
        {
            let dir = std::path::Path::new(&args[2])
                .canonicalize()
                .with_context(|| format!("project dir {}", args[2]))?;
            return Ok(Outcome::Exit(snapshot_build_app(&dir)));
        }
        #[cfg(not(all(feature = "snapshot", windows)))]
        {
            eprintln!(
                "[carbon-mini] --snapshot-build: this runtime was built without the \
                 `snapshot` feature; nothing to do."
            );
            return Ok(Outcome::Exit(Ok(())));
        }
    }

    // Pool-wait mode: `products/carbon-launcher`'s daemon (see its own
    // README) pre-spawns a carbon-mini process ahead of any real `carbon
    // run` request specifically to pre-pay the OS process-creation +
    // binary-load cost — measured directly at ~65-83ms on Windows, ALL of
    // it incurred before any Rust code (this function included) starts
    // running at all. That means simply being an already-running process,
    // waiting right here, already captures nearly the whole win — no need
    // to also pre-create the window with a placeholder size and resize
    // later, which would need restructuring main()'s flow for a much
    // smaller marginal gain (window creation is only ~15-30ms of the
    // total). So: block HERE, before anything else (including the
    // build-time-mode dispatch above — a pooled process is never a
    // build-time invocation), polling `handoff_file` for the daemon to
    // drop the real args in — a plain JSON file, not a socket, the same
    // "poll a file, act when it appears" shape this file's own --dev
    // bundle-reload watcher already uses elsewhere in this codebase. Once
    // found, this becomes an ordinary launch: the handoff's fields are
    // exactly `ParsedArgs`'s fields, so everything downstream in main()
    // is completely unaware this process didn't start with them on argv.
    if let Some(pos) = args.iter().position(|a| a == "--pool-wait") {
        if let Some(handoff_file) = args.get(pos + 1).cloned() {
            return Ok(Outcome::Run(wait_for_pool_handoff(&handoff_file)?));
        }
    }

    // Test hook: auto-exit after N ms so a launched app exits cleanly (and its
    // stderr/timing logs flush) without needing a force-kill.
    if let Some(ms) = std::env::var("CARBON_TEST_EXIT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            std::process::exit(0);
        });
    }

    // Parse positional project dir + flags. --dev enables in-process HMR:
    // a background thread polls the bundle file's mtime and posts a
    // UserEvent::ReloadBundle when it changes; the event-loop handler
    // re-evals the new bundle in the SAME rquickjs context (so the JS-side
    // __hmr_state Map survives) and rebuilds the scene.
    //
    // --window-label <name> + --window-opts <json>: spawned by
    // `__cm_window_open(label, optsJson)` to create a second native
    // window. The child process runs the SAME bundle as the parent;
    // the bundle reads its label via `__cm_window_label()` and renders
    // the appropriate page. opts are forwarded as a free-form JSON
    // string accessible via `__cm_window_opts_json()`. This is the v1
    // multi-window mechanism — process-per-window, naturally isolated,
    // no main-loop refactor required.
    let mut dev_mode = false;
    let mut positional: Option<PathBuf> = None;
    let mut window_label: String = "main".to_string();
    let mut window_opts_json: String = "{}".to_string();
    let mut iter = args.iter().skip(1).peekable();
    while let Some(a) = iter.next() {
        if a == "--dev" {
            dev_mode = true;
        } else if a == "--window-label" {
            if let Some(v) = iter.next() {
                window_label = v.clone();
            }
        } else if a == "--window-opts" {
            if let Some(v) = iter.next() {
                window_opts_json = v.clone();
            }
        } else if !a.starts_with("--") {
            if positional.is_none() {
                positional = Some(PathBuf::from(a));
            }
        }
    }
    // Mirror label + opts into static slots so JS-side host imports
    // resolve them via `__cm_window_label()` / `__cm_window_opts_json()`.
    crate::native::window::set_window_label(window_label.clone());
    crate::native::window::set_window_opts_json(window_opts_json.clone());
    let project_dir = positional.unwrap_or_else(|| std::env::current_dir().unwrap());
    let project_dir = project_dir
        .canonicalize()
        .with_context(|| format!("project dir {}", project_dir.display()))?;

    Ok(Outcome::Run(ParsedArgs {
        dev_mode,
        project_dir,
        window_opts_json,
    }))
}

/// Poll `handoff_file` until `products/carbon-launcher`'s daemon writes it —
/// a plain JSON object `{"project_dir": "...", "dev_mode": bool,
/// "window_opts_json": "..."}`, deliberately the exact same fields
/// `ParsedArgs` has, so a pooled instance becomes an ordinary launch the
/// moment this returns. No timeout: an unclaimed pooled instance is meant to
/// wait indefinitely — the daemon's OWN idle-timeout is what reclaims an
/// abandoned one (by killing this process outright), not this loop giving up
/// on its own.
fn wait_for_pool_handoff(handoff_file: &str) -> Result<ParsedArgs> {
    #[derive(serde::Deserialize)]
    struct Handoff {
        project_dir: String,
        #[serde(default)]
        dev_mode: bool,
        #[serde(default = "default_window_opts")]
        window_opts_json: String,
    }
    fn default_window_opts() -> String {
        "{}".to_string()
    }

    let path = std::path::Path::new(handoff_file);
    loop {
        // Delete AFTER a successful parse, not before: deleting first would
        // risk losing a good write that races with the daemon still in the
        // middle of writing it — a partial read here just fails to parse
        // and we try again next tick instead.
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(handoff) = serde_json::from_str::<Handoff>(&text) {
                let _ = std::fs::remove_file(path);
                let project_dir = std::path::PathBuf::from(&handoff.project_dir)
                    .canonicalize()
                    .with_context(|| format!("pool handoff project dir {}", handoff.project_dir))?;
                crate::native::window::set_window_label("main".to_string());
                crate::native::window::set_window_opts_json(handoff.window_opts_json.clone());
                return Ok(ParsedArgs {
                    dev_mode: handoff.dev_mode,
                    project_dir,
                    window_opts_json: handoff.window_opts_json,
                });
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
