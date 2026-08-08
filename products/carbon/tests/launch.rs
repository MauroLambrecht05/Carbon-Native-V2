// Does the runtime actually start an app?
//
// This is the test the whole migration is verified against. Everything else
// checks that code compiles, that names line up, that a parser handles an
// edge case. This one starts the real binary against a real bundle and watches
// it reach first paint.
//
// It exists because the composition root — 4,400 lines holding the startup
// ordering, the event loop, and 56 host-function registrations — has no unit
// tests and cannot usefully have any. What it can have is: run it, and check
// what came out.
//
// ── HOW IT EXITS ────────────────────────────────────────────────────────────
// `CARBON_TEST_EXIT_MS` makes the runtime exit cleanly after N ms. That is a
// production hook, not a test-only affordance, and it is why this is possible
// at all: without it the process opens a window and waits for a human, and the
// only way out is a kill, which loses the exit code and truncates stderr.
//
// ── WHY THE PHASE ORDER MATTERS ─────────────────────────────────────────────
// The 27 phases are a contract, pinned in
// .tools/validation/baselines/startup-phases.txt. Their ORDER encodes the
// startup dependency graph: a window before a surface, a surface before a
// scene, fonts before JS, host imports before the bundle, the bundle before
// first paint. Evaluate the bundle before host imports are registered and every
// app dies on an undefined global — with no compile error anywhere, because the
// boundary is strings.
//
// Splitting this composition root is the next piece of work, and reordering is
// exactly how that goes wrong. This is what will catch it.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The fixture: a real scaffolded project with a prebuilt bundle.
///
/// Checked in rather than built here on purpose. Building it would need the
/// TypeScript toolchain, Bun, and a working `carbon build` — which would make a
/// runtime test fail for reasons that have nothing to do with the runtime.
fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hello-app")
}

/// Runs the runtime against the fixture and returns (exit code, stderr).
fn launch(exit_after_ms: u64) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_carbon-mini"))
        .arg(fixture())
        .env("CARBON_TEST_EXIT_MS", exit_after_ms.to_string())
        .output()
        .expect("failed to spawn carbon-mini");

    (output.status.code(), String::from_utf8_lossy(&output.stderr).into_owned())
}

/// The `[timing] phase=<name>` lines, in the order they were emitted.
fn phases(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter_map(|line| line.split("phase=").nth(1))
        .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// The pinned sequence. Kept here as a literal rather than read from the
/// baseline file so this test fails on a *reordering*, not just on a count.
const EXPECTED: &[&str] = &[
    "args_resolved",
    "event_loop_built",
    "window_built",
    "softbuffer_ctx",
    "softbuffer_ready",
    "scene_created",
    "text_engine_created",
    "font_user_resolved",
    "font_preloaded",
    "js_runtime_ready",
    "host_imports_registered",
    "native.fs",
    "native.process",
    "native.dialog_shell_clip_notif_autostart_winstate_keychain",
    "native.store_pty",
    "native.os_log_invoke_window_app",
    "native.net",
    "native_registered",
    "carbon_dispatcher_installed",
    "plugins_loaded",
    "image_registered",
    "audio_registered",
    "bundle_evaluated",
    "first_paint_before_show",
    "window_show_scheduled",
    "first_paint_visible",
    "effects_drained",
];

#[test]
fn the_runtime_starts_an_app_and_exits_cleanly() {
    let (code, stderr) = launch(3000);
    assert_eq!(
        code,
        Some(0),
        "carbon-mini did not exit cleanly.\n--- stderr ---\n{stderr}"
    );
}

#[test]
fn it_reaches_first_paint() {
    let (_, stderr) = launch(3000);
    // Not just "did not crash" — it got as far as putting something on screen.
    assert!(
        stderr.contains("startup → first paint"),
        "no first-paint line.\n--- stderr ---\n{stderr}"
    );
    assert!(
        stderr.contains("startup → content ready"),
        "reached first paint but never drained effects.\n--- stderr ---\n{stderr}"
    );
}

#[test]
fn it_evaluates_the_bundle() {
    let (_, stderr) = launch(3000);
    // bundle_evaluated is the phase that proves the app's own JavaScript ran,
    // rather than the runtime starting and painting an empty window.
    assert!(
        phases(&stderr).contains(&"bundle_evaluated".to_string()),
        "the bundle was never evaluated.\n--- stderr ---\n{stderr}"
    );
}

#[test]
fn the_startup_phases_are_exactly_the_pinned_sequence() {
    let (_, stderr) = launch(3000);
    let actual = phases(&stderr);

    assert_eq!(
        actual.len(),
        EXPECTED.len(),
        "phase COUNT changed: expected {}, got {}.\nactual: {actual:#?}",
        EXPECTED.len(),
        actual.len(),
    );

    for (i, (want, got)) in EXPECTED.iter().zip(actual.iter()).enumerate() {
        assert_eq!(
            want, got,
            "phase {i} differs: expected {want:?}, got {got:?}.\n\
             The startup ORDER is a contract — see \
             .tools/validation/baselines/startup-phases.txt.\nactual: {actual:#?}"
        );
    }
}

#[test]
fn host_imports_are_registered_before_the_bundle_runs() {
    // The single ordering constraint that matters most. The bundle calls
    // __cm_* globals the moment it evaluates; if registration has not happened
    // the app dies on `undefined is not a function`, and nothing in either
    // toolchain would have warned about it.
    let (_, stderr) = launch(3000);
    let p = phases(&stderr);

    let registered = p.iter().position(|x| x == "native_registered");
    let evaluated = p.iter().position(|x| x == "bundle_evaluated");

    let (registered, evaluated) = (
        registered.expect("native_registered phase missing"),
        evaluated.expect("bundle_evaluated phase missing"),
    );
    assert!(
        registered < evaluated,
        "host imports registered AFTER the bundle evaluated ({registered} vs {evaluated})"
    );
}

#[test]
fn a_missing_project_directory_fails_rather_than_hanging() {
    // The failure path deserves a test too: pointed at nothing, the runtime
    // should exit, not open a window and wait.
    let output = Command::new(env!("CARGO_BIN_EXE_carbon-mini"))
        .arg(fixture().join("does-not-exist"))
        .env("CARBON_TEST_EXIT_MS", "3000")
        .output()
        .expect("failed to spawn carbon-mini");

    assert!(
        output.status.code().is_some(),
        "the process did not exit on its own"
    );
}
