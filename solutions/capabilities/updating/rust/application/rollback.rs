use crate::state::SlotState;
use anyhow::Result;
use std::path::Path;

pub fn handle_crash_detection(
    state: &mut SlotState,
    crash_threshold: u32,
    install_dir: &Path,
) -> Result<bool> {
    if state.needs_rollback(crash_threshold) {
        state.rollback(install_dir)?;
        return Ok(true);
    }
    Ok(false)
}
