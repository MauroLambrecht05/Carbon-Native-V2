// Reading carbon.toml at startup.
//
// Deliberately hand-rolled rather than going through carbon-core: these run
// before anything else and only need four values out of the file. The full
// schema lives in contracts/app.

use super::*;

/// Read just the [app] section from carbon.toml — name + version. Best-effort:
/// returns ("", "") if the file is missing or unparseable, matching the
/// runtime's "no carbon.toml is fine" stance.
pub(crate) fn read_app_metadata(project_dir: &PathBuf) -> (String, String) {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return (String::new(), String::new()),
    };
    // We intentionally avoid pulling in carbon-core's full Config here —
    // older carbon.toml files in the test fixtures sometimes lack
    // [app.window] which carbon-core requires. A minimal local schema with
    // only the fields we need is more forgiving.
    #[derive(serde::Deserialize, Default)]
    struct LocalApp {
        #[serde(default)]
        name: String,
        #[serde(default)]
        version: String,
    }
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        app: LocalApp,
    }
    let cfg: LocalCfg = basic_toml::from_str(&text).unwrap_or_default();
    (cfg.app.name, cfg.app.version)
}

/// Returns (width, height, decorated). `decorated = false` lets the React
/// shell render its own title bar / window controls — terax-style apps
/// expect this because their layout starts at viewport y=0.
pub(crate) fn read_window_cfg(project_dir: &PathBuf) -> (f64, f64, bool) {
    let default = (1100.0_f64, 720.0_f64, true);
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return default,
    };
    #[derive(serde::Deserialize, Default)]
    struct WinSection {
        width: Option<f64>,
        height: Option<f64>,
        decorated: Option<bool>,
    }
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        window: WinSection,
    }
    let cfg: LocalCfg = basic_toml::from_str(&text).unwrap_or_default();
    let w = cfg.window.width.unwrap_or(default.0).max(320.0);
    let h = cfg.window.height.unwrap_or(default.1).max(240.0);
    let decorated = cfg.window.decorated.unwrap_or(default.2);
    (w, h, decorated)
}

/// Read `[runtime] process` from carbon.toml — same convention as `audio`/
/// `image`. Defaults to false: an app that never declares it needs process
/// spawning never gets `__cm_proc_exec`/`__cm_proc_spawn` installed on
/// `globalThis` at all, for anyone — closing this at the resolver/import
/// level alone wouldn't be enough, since the raw global would still be
/// reachable by name regardless of what any bundler-level import gate says.
pub(crate) fn read_process_enabled(project_dir: &PathBuf) -> bool {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return false,
    };
    #[derive(serde::Deserialize, Default)]
    struct RuntimeSection {
        #[serde(default)]
        process: bool,
    }
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        runtime: RuntimeSection,
    }
    basic_toml::from_str::<LocalCfg>(&text)
        .map(|c| c.runtime.process)
        .unwrap_or(false)
}

/// Read `[net] allowed_origins` from carbon.toml. An app that declares none
/// has zero network egress — the fetch/WebSocket machinery is present but
/// every connection is refused, not silently allowed. `"*"` as the sole
/// entry is an explicit, deliberate opt-out of the check, not a default.
#[cfg(feature = "network")]
pub(crate) fn read_net_section(project_dir: &PathBuf) -> Vec<String> {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    #[derive(serde::Deserialize, Default)]
    struct NetSection {
        #[serde(default)]
        allowed_origins: Vec<String>,
    }
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        net: NetSection,
    }
    basic_toml::from_str::<LocalCfg>(&text)
        .map(|c| c.net.allowed_origins)
        .unwrap_or_default()
}

/// `[updater]` from carbon.toml — the config the background updater thread
/// (mini.rs, `#[cfg(feature = "updater")]`) needs to know what to fetch and
/// which key to trust. Previously that thread read raw env vars
/// (`CARBON_MANIFEST_URL`) instead, because nothing here parsed this section
/// at all — the same "hand-rolled, only the fields we need" convention as
/// `read_net_section`/`read_process_enabled` above, not carbon-core's Config.
// Gated to match read_updater_section's own call site in mini.rs
// (`#[cfg(feature = "updater")]`) — without this, these compiled
// unconditionally into every binary regardless of whether the `updater`
// feature (and thus the only caller) was even enabled.
#[cfg(feature = "updater")]
#[derive(serde::Deserialize, Clone)]
pub(crate) struct UpdaterSection {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub pubkey: String,
    /// The app's base distribution URL — `channel` (below) gets appended to
    /// find one channel's feed: `{url}/{channel}/manifest.json`,
    /// `{url}/{channel}/yanked.json`. Matches @carbon/publishing's own S3
    /// layout exactly (`<bucket>/<prefix><channel>/manifest.json`), so
    /// `url` here is that bucket+prefix and nothing about switching
    /// channels needs a different URL, only a different `channel` value.
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(default = "default_crash_threshold")]
    pub crash_threshold: u32,
}

#[cfg(feature = "updater")]
fn yes() -> bool {
    true
}
#[cfg(feature = "updater")]
fn default_channel() -> String {
    "stable".to_string()
}
#[cfg(feature = "updater")]
fn default_crash_threshold() -> u32 {
    3
}

/// Returns `None` when `[updater]` is absent, `enabled = false`, or missing
/// either `pubkey` or `url` — there is nothing safe or useful to do with an
/// updater that has no key to verify against or nowhere to fetch from, so
/// the caller (mini.rs) treats `None` as "don't spawn the background thread
/// at all" rather than spawning one that would only ever fail.
#[cfg(feature = "updater")]
pub(crate) fn read_updater_section(project_dir: &PathBuf) -> Option<UpdaterSection> {
    let path = project_dir.join("carbon.toml");
    let text = std::fs::read_to_string(&path).ok()?;
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        updater: Option<UpdaterSection>,
    }
    let section = match basic_toml::from_str::<LocalCfg>(&text) {
        Ok(c) => c.updater?,
        Err(e) => {
            eprintln!(
                "[carbon-mini-updater] WARNING: failed to parse [updater] in {}: {e}",
                path.display()
            );
            return None;
        }
    };
    if !section.enabled || section.pubkey.is_empty() || section.url.is_empty() {
        return None;
    }
    Some(section)
}

/// Read `carbon/manifest.toml` — the real source of truth for which plugins
/// compose this app (both locally-authored and fetched/vendor), maintained by
/// `carbon plugin new`/`add`/`enable`/`disable`, never hand-edited. Missing or
/// unparseable ⇒ empty (no plugins to load), matching every other section's
/// "no file is fine" posture in this module.
///
/// carbon.toml's `[plugins]` table (see `read_plugins_section` below) only
/// grants capabilities to names that appear here — it never says a plugin
/// exists.
pub(crate) fn read_app_manifest(project_dir: &PathBuf) -> carbon_core::config::AppManifest {
    let path = project_dir.join("carbon").join("manifest.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Default::default(),
    };
    match basic_toml::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            eprintln!(
                "[carbon-mini-plugin] WARNING: failed to parse {}: {e}",
                path.display()
            );
            Default::default()
        }
    }
}

/// Read [plugins] from carbon.toml — capability GRANTS only, keyed by plugin
/// name (see `carbon_core::config::CapabilityGrant`). Returns an empty map if
/// carbon.toml is missing, has no [plugins] section, or fails to parse it.
/// The loader treats an absent entry as "declared in the manifest, zero
/// capabilities granted" — not as "does not exist".
pub(crate) fn read_plugins_section(
    project_dir: &PathBuf,
) -> std::collections::BTreeMap<String, carbon_core::config::CapabilityGrant> {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Default::default(),
    };
    // Local schema mirroring core::config::PluginsSection — gives us a
    // non-strict parse that ignores all the other top-level sections.
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default)]
        plugins: std::collections::BTreeMap<String, carbon_core::config::CapabilityGrant>,
    }
    match basic_toml::from_str::<LocalCfg>(&text) {
        Ok(c) => c.plugins,
        Err(e) => {
            // A parse error in [plugins] is worth surfacing — silently
            // skipping would hide typos.
            eprintln!(
                "[carbon-mini-plugin] WARNING: failed to parse [plugins] in {}: {e}",
                path.display()
            );
            Default::default()
        }
    }
}

/// Read [dev-signing] trusted_keys from carbon.toml — the per-project trust
/// anchors a local (unofficially-signed) plugin's artifact may verify
/// against instead of Carbon's own key. See
/// `carbon_core::config::DevSigningSection`'s doc comment for the full
/// picture. Returns an empty list (trust only Carbon's key) if carbon.toml
/// is missing, has no [dev-signing] section, or fails to parse it.
pub(crate) fn read_dev_signing_trusted_keys(project_dir: &PathBuf) -> Vec<String> {
    let path = project_dir.join("carbon.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Default::default(),
    };
    #[derive(serde::Deserialize, Default)]
    struct LocalCfg {
        #[serde(default, rename = "dev-signing")]
        dev_signing: carbon_core::config::DevSigningSection,
    }
    match basic_toml::from_str::<LocalCfg>(&text) {
        Ok(c) => c.dev_signing.trusted_keys,
        Err(e) => {
            eprintln!(
                "[carbon-mini-plugin] WARNING: failed to parse [dev-signing] in {}: {e}",
                path.display()
            );
            Default::default()
        }
    }
}
