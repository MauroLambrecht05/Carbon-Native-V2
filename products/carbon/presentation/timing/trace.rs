// Startup phase tracing.
//
// The phase names emitted here are a contract: the sequence in
// .tools/validation/baselines/startup-phases.txt, asserted by tests/launch.rs.
// Their ORDER encodes the startup dependency graph.
//
// `tlog` is also the implementation this binary hands to
// carbon_os::register_all as a PhaseLogger — blitz supplies a different one,
// which is why that is a port rather than a shared function.

use super::*;

/// Per-phase startup timing. Prints one line per phase showing how long THAT
/// phase took (`+Δms`) plus the cumulative time since start (`= total`). On by
/// default so `carbon run` shows the breakdown in the console; silence with
/// CARBON_NO_TIMING=1. The `phase=…`/`elapsed_ms=…` tokens are kept for the
/// bench harness that greps them.
pub(crate) fn timing_log(phase: &str, since: Instant) {
    if std::env::var_os("CARBON_NO_TIMING").is_some() {
        return;
    }
    use std::io::Write;
    // Track the previous phase's instant so we can report per-phase deltas.
    static LAST: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    let now = Instant::now();
    let elapsed = now.duration_since(since).as_secs_f64() * 1000.0;
    let delta = {
        let mut g = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let d = match *g {
            Some(prev) => now.duration_since(prev).as_secs_f64() * 1000.0,
            None => elapsed,
        };
        *g = Some(now);
        d
    };
    // Clean + aligned, while keeping the `phase=…`/`elapsed_ms=…` tokens the
    // bench harness greps for.
    eprintln!("[timing] phase={phase:<28} +{delta:>8.2}ms   total {elapsed:>8.2}ms   elapsed_ms={elapsed:.2}");
    let _ = std::io::stderr().flush();
}

/// Process start instant, so any module (not just `main`) can emit a granular
/// timing phase via [`tlog`] without threading the start `Instant` everywhere.
pub(crate) static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Emit a timing phase relative to process start. Used by sub-modules
/// (e.g. `native::register_all`) for fine-grained sub-step timing.
pub fn tlog(phase: &str) {
    if let Some(t0) = START.get() {
        timing_log(phase, *t0);
    }
}

/// Final "everything done" line: the grand total since start.
pub(crate) fn timing_done(label: &str, since: Instant) {
    if std::env::var_os("CARBON_NO_TIMING").is_some() {
        return;
    }
    use std::io::Write;
    let ms = since.elapsed().as_secs_f64() * 1000.0;
    eprintln!("[timing] ───────────────────────────────────────────────");
    eprintln!("[timing] ✓ {label}: TOTAL {ms:.2} ms");
    let _ = std::io::stderr().flush();
}

