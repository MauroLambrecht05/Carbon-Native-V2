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

    // One decision, made the same way by every updater (carbon_updater::decide,
    // held to solutions/contracts/update/fixtures/conformance.json): a
    // withdrawn running version rolls back before anything else is
    // considered; only a strictly newer, compatible, non-withdrawn version in
    // this install's rollout bucket, on this install's channel, is installed.
    let stop_list = carbon_updater::fetch_stop_list(base_url)?;
    match carbon_updater::decide(
        &manifest,
        &stop_list,
        current_version,
        &state.installation_id,
        platform,
        Some(&cfg.channel),
    ) {
        carbon_updater::Decision::Rollback => {
            eprintln!(
                "[carbon-updater] running version {current_version} of {app_name} is withdrawn — \
                 rolling back to {:?} for next launch",
                state.previous_slot
            );
            state.rollback(install_dir)?;
            return Ok(());
        }
        // Nothing to do this pass: already current, not in this rollout
        // stage yet, incompatible, or no artifact for this platform.
        carbon_updater::Decision::None(_) => return Ok(()),
        carbon_updater::Decision::Update { .. } => {}
    }

    eprintln!(
        "[carbon-updater] {app_name} {} available (currently running {current_version})",
        manifest.version
    );

    let staging_dir = install_dir.join("staging");
    let downloaded = carbon_updater::downloader::download_update(
        &manifest,
        platform,
        &staging_dir,
        &cfg.pubkey,
    )?;
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
    eprintln!(
        "[carbon-updater] staged {} — will be active next launch",
        manifest.version
    );

    Ok(())
}
