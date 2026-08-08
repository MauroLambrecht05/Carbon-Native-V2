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
    let cfg: LocalCfg = toml::from_str(&text).unwrap_or_default();
    (cfg.app.name, cfg.app.version)
}

/// Initial window dimensions in logical pixels. Reads `[window]` from
/// carbon.toml; otherwise returns sensible desktop-app defaults (1100×720).
/// Always returns positive values — never zero or negative.
pub(crate) fn read_window_size(project_dir: &PathBuf) -> (f64, f64) {
    let cfg = read_window_cfg(project_dir);
    (cfg.0, cfg.1)
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
    let cfg: LocalCfg = toml::from_str(&text).unwrap_or_default();
    let w = cfg.window.width.unwrap_or(default.0).max(320.0);
    let h = cfg.window.height.unwrap_or(default.1).max(240.0);
    let decorated = cfg.window.decorated.unwrap_or(default.2);
    (w, h, decorated)
}

/// Read [plugins] from carbon.toml. Returns an empty map if carbon.toml is
/// missing, has no [plugins] section, or fails to parse the section. The
/// loader treats an empty map as a no-op.
pub(crate) fn read_plugins_section(
    project_dir: &PathBuf,
) -> std::collections::BTreeMap<String, carbon_core::config::PluginEntry> {
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
        plugins: std::collections::BTreeMap<String, carbon_core::config::PluginEntry>,
    }
    match toml::from_str::<LocalCfg>(&text) {
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

