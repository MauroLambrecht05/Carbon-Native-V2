// The background updater thread's actual work, one pass at a time — spawned
// by mini.rs, once, when [updater] is enabled and configured. Every step
// here used to be a TODO comment; see mini.rs's own comment at the spawn
// site for what changed and why.
//
// Runs on a plain std::thread (no async runtime around it), so everything
// this calls into (carbon_updater's fetch_manifest / fetch_stop_list /
// downloader::download_update) is the crate's blocking API.

use crate::manifest::UpdaterSection;
use anyhow::Result;
use std::path::Path;

/// Best-effort mapping to the same target-triple shape `carbon publish app
/// --platform` expects (see PublishReleaseUseCase's own doc comment) — free-
/// form on both sides, this is just the convention. Extend the match arms as
/// new (OS, arch) combinations actually ship, rather than guessing ahead.
pub(crate) fn current_platform_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        (os, arch) => {
            eprintln!("[carbon-updater] WARNING: no known target-triple mapping for ({os}, {arch}) — update checks will never match a platform entry");
            "unknown-unknown-unknown"
        }
    }
}

/// One fetch-verify-check-act cycle. Errors are the caller's to log and
/// retry next interval — a single failed check (network blip, server
/// hiccup) must never be fatal to the running app.
pub(crate) fn check_for_update_once(
    base_url: &str,
    cfg: &UpdaterSection,
    install_dir: &Path,
    app_name: &str,
    current_version: &str,
    platform: &str,
) -> Result<()> {
    let (manifest_json, manifest) = carbon_updater::fetch_manifest(base_url)?;
    let manifest_sig = carbon_updater::fetch_manifest_sig(base_url)?;
    carbon_updater::verify_manifest_signature(&manifest_json, &manifest_sig, &cfg.pubkey)?;

    let mut state = carbon_updater::SlotState::load(install_dir)?;

    // Is what's CURRENTLY RUNNING yanked? Checked before anything about a
    // new version — a yanked current version needs to roll back regardless
    // of whether a fix is out yet.
    let stop_list = carbon_updater::fetch_stop_list(base_url)?;
    if carbon_updater::stop_list::is_yanked(&stop_list, current_version).is_some() {
        eprintln!(
            "[carbon-updater] running version {current_version} of {app_name} is yanked — \
             rolling back to {:?} for next launch",
            state.previous_slot
        );
        state.rollback(install_dir)?;
        return Ok(());
    }

    if manifest.version == current_version {
        return Ok(()); // Already current — nothing to do this pass.
    }

    // KNOWN LIMITATION: manifest.min_version (the oldest version allowed to
    // jump straight to this release) is not enforced here — comparing it
    // correctly needs real semver ordering, which nothing in this crate
    // pulls in yet. Skipping the gate rather than comparing version strings
    // naively (which would accept or refuse the wrong releases silently) —
    // tracked as a real gap, not quietly "handled".
    let _ = &manifest.min_version;

    if !carbon_updater::in_rollout(&state.installation_id, &manifest.version, manifest.rollout as u8) {
        return Ok(()); // Not in this rollout stage yet — check again next interval.
    }

    eprintln!(
        "[carbon-updater] {app_name} {} available (currently running {current_version})",
        manifest.version
    );

    let staging_dir = install_dir.join("staging");
    let downloaded = carbon_updater::downloader::download_update(&manifest, platform, &staging_dir, &cfg.pubkey)?;
    eprintln!(
        "[carbon-updater] downloaded + verified {} ({} bytes)",
        downloaded.path.display(),
        downloaded.size
    );

    // Stages the new version as the active slot for the NEXT launch — this
    // does not restart the currently-running process. mark_launch_started /
    // mark_first_frame (run_loop.rs) own the crash-counter side of what
    // happens after that next launch actually starts.
    carbon_updater::apply::apply_update(install_dir, &staging_dir, &manifest.version, platform)?;
    eprintln!("[carbon-updater] staged {} — will be active next launch", manifest.version);

    Ok(())
}
