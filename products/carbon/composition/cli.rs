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
