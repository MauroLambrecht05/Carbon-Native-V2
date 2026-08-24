use crate::state::SlotState;
use anyhow::Result;
use std::fs;
use std::path::Path;

pub fn promote_staging(staging_dir: &Path, slots_dir: &Path, version: &str) -> Result<()> {
    let staged_version = staging_dir.join(version);
    let target_slot = slots_dir.join(version);

    if !staged_version.exists() {
        anyhow::bail!("Staged version {version} does not exist");
    }

    fs::create_dir_all(slots_dir)?;

    if target_slot.exists() {
        fs::remove_dir_all(&target_slot)?;
    }

    fs::rename(staged_version, target_slot)?;

    Ok(())
}

pub fn apply_update(
    install_dir: &Path,
    staging_dir: &Path,
    version: &str,
    _platform: &str,
) -> Result<()> {
    let slots_dir = install_dir.join("slots");
    promote_staging(staging_dir, &slots_dir, version)?;

    let mut state = SlotState::load(install_dir)?;
    state.previous_slot = Some(state.active_slot.clone());
    state.active_slot = version.to_string();
    state.in_progress_count = 0;
    state.save(install_dir)?;

    Ok(())
}
