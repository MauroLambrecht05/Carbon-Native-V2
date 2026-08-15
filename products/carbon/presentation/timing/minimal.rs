// blitz's startup phase tracer.
//
// One line per phase, gated IN by CARBON_MINI_TIMING — where mini's traces
// per-phase deltas and is gated OUT by CARBON_NO_TIMING. That difference is
// exactly why tlog is a port: carbon_os::register_all takes it as a parameter
// rather than the two binaries sharing one.

use super::*;

/// Sub-step timing hook the native modules call. No-op unless CARBON_MINI_TIMING.
pub fn tlog(phase: &str) {
    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!("[timing] {phase}");
    }
}
