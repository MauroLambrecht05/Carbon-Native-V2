// Optional subsystems, registered only when compiled in AND enabled.
//
// Each has two definitions selected by #[cfg]: the real one, and a no-op with
// the same signature. That keeps main() free of feature gates — it calls
// `maybe_register_image` unconditionally and the linker decides.

use super::*;

// carbon-image: opt-in image loading (DISABLED in Phase 1A to save 0.8 MB).
// When enabled, activated when the env var CARBON_IMAGE_PATHS is set
// (comma-separated glob allowlist) or CARBON_IMAGE=1 (dev mode).
#[cfg(feature = "image")]
pub(crate) fn maybe_register_image(
    js_ctx: &rquickjs::Context,
    project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    // Read the glob allowlist from env. If unset, image loading is disabled.
    let raw = std::env::var("CARBON_IMAGE_PATHS").unwrap_or_default();
    let enable_all = std::env::var("CARBON_IMAGE").ok().as_deref() == Some("1");

    if raw.is_empty() && !enable_all {
        return Ok(()); // image loading off
    }

    let mut globs: Vec<String> = if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(',').map(|s| s.trim().to_string()).collect()
    };

    if enable_all && globs.is_empty() {
        // Dev mode: allow everything.
        globs.push("**".to_string());
    }

    // Expand ${APP} → project_dir.
    let app_path = project_dir.to_string_lossy().replace('\\', "/");
    let globs: Vec<String> = globs
        .into_iter()
        .map(|g| g.replace("${APP}", &app_path))
        .collect();

    let cache = carbon_image::default_cache();
    js_ctx.with(|ctx| -> anyhow::Result<()> {
        carbon_image::register_image(&ctx, cache, globs)
            .map_err(|e| anyhow::anyhow!("register_image: {e}"))?;
        Ok(())
    })?;

    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!("[carbon-mini] image loading registered");
    }
    Ok(())
}

#[cfg(not(feature = "image"))]
pub(crate) fn maybe_register_image(
    _js_ctx: &rquickjs::Context,
    _project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    // Image feature disabled; no-op.
    Ok(())
}

/// Register Web Audio API globals (DISABLED in Phase 1A to save 0.4 MB).
/// When enabled, only if env var or carbon.toml enables it.
#[cfg(feature = "audio")]
pub(crate) fn maybe_register_audio(
    js_ctx: &rquickjs::Context,
    project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    let audio_from_env = std::env::var_os("CARBON_MINI_AUDIO").is_some();
    let audio_from_toml = std::fs::read_to_string(project_dir.join("carbon.toml"))
        .map(|s| s.contains("audio = true"))
        .unwrap_or(false);

    if !audio_from_env && !audio_from_toml {
        return Ok(());
    }

    js_ctx.with(|ctx| -> anyhow::Result<()> {
        carbon_audio::register_audio(&ctx).map_err(|e| anyhow::anyhow!("register_audio: {e}"))?;
        Ok(())
    })?;

    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!("[carbon-mini] Web Audio API registered");
    }
    Ok(())
}

#[cfg(not(feature = "audio"))]
pub(crate) fn maybe_register_audio(
    _js_ctx: &rquickjs::Context,
    _project_dir: &std::path::Path,
) -> anyhow::Result<()> {
    // Audio feature disabled; no-op.
    Ok(())
}
