// carbon.toml manifest parsing.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub app: AppSection,
    #[serde(default)]
    pub runtime: RuntimeSection,
    /// Native plugin CAPABILITY GRANTS, keyed by plugin name. This is not a
    /// plugin registry — which plugins exist and where their binary lives is
    /// entirely governed by `carbon/manifest.toml` + `carbon/native/<os>/
    /// <arch>/`. This section only grants capabilities; a plugin needing
    /// none needs no entry here. See [`CapabilityGrant`].
    ///
    /// Plugin loading is driven by `solutions/infrastructure/plugin-host`'s
    /// `plugin_loader.rs`. If this section is missing or empty, every
    /// manifest-declared plugin still loads — just with zero capabilities.
    #[serde(default)]
    pub plugins: PluginsSection,
}

/// Selects which carbon backend executes the app. The CLI reads this to pick
/// which `target/{dist,release}/carbon-<backend>` to spawn. Apps can
/// override per-invocation with `carbon run --runtime <name>`.
#[derive(Debug, Deserialize)]
pub struct RuntimeSection {
    #[serde(default = "default_backend")]
    pub backend: String,
    /// Pre-compile the JS bundle to QuickJS bytecode + zstd at build time.
    /// On the mini backend this saves ~5-10 ms cold start AND shrinks the
    /// shipped bundle (~36 KB JS → ~28 KB .qbc.zst). Off by default because
    /// for trivial bundles the compress/decompress overhead breaks even.
    /// Turn on for apps with non-trivial JS (>50 KB source).
    #[serde(default)]
    pub bytecode: bool,
    /// Enable image loading via the carbon-image crate. Default: false.
    ///
    /// When false, `__carbon_image_load_path`, `__carbon_image_load_bytes`,
    /// and `__carbon_image_decode_sync` are NOT registered as globals —
    /// there is zero binary cost from the image decoders when this is off.
    ///
    /// When true, the runtime calls `carbon_image::register_image(...)` at
    /// startup and applies the path allowlist from
    /// `[app.capabilities] image.read = [...]`.
    #[serde(default)]
    pub image: bool,
    /// Enable the Web Audio API (AudioContext, GainNode, OscillatorNode, etc.).
    /// When false (default), no audio device is opened and there is zero
    /// cold-start cost. Set to true in carbon.toml for apps that use audio:
    ///
    ///   [runtime]
    ///   audio = true
    #[serde(default)]
    pub audio: bool,
}

impl Default for RuntimeSection {
    fn default() -> Self {
        Self {
            backend: default_backend(),
            bytecode: false,
            image: false,
            audio: false,
        }
    }
}

// Must match DEFAULT_BACKEND in shared/logic/ts/src/backends.ts and the `default`
// on runtime.backend in shared/config/carbon.schema.json. The conformance
// suite fails if these three disagree. This said "webview2" until that
// backend was archived, which made every manifest without an explicit
// [runtime].backend resolve to a runtime that no longer exists.
fn default_backend() -> String {
    "mini".into()
}

#[derive(Debug, Deserialize)]
pub struct AppSection {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub dev_url: Option<String>,
    #[serde(default)]
    pub window: WindowSection,
    #[serde(default)]
    pub capabilities: CapabilitiesSection,
}

#[derive(Debug, Deserialize)]
pub struct WindowSection {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    #[serde(default = "yes")]
    pub resizable: bool,
    #[serde(default = "yes")]
    pub decorations: bool,
}

impl Default for WindowSection {
    fn default() -> Self {
        Self {
            title: None,
            width: default_width(),
            height: default_height(),
            resizable: yes(),
            decorations: yes(),
        }
    }
}

fn default_width() -> u32 {
    800
}
fn default_height() -> u32 {
    600
}
fn yes() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
pub struct CapabilitiesSection {
    #[serde(default, rename = "fs.read")]
    pub fs_read: Vec<String>,
    #[serde(default, rename = "fs.write")]
    pub fs_write: Vec<String>,
    #[serde(default, rename = "net.fetch")]
    pub net_fetch: Vec<String>,
    #[serde(default, rename = "system.notify")]
    pub system_notify: bool,
    /// Glob-based allowlist for image file paths.
    ///
    /// Each entry is a glob pattern (supports `**` and `*`). Variable
    /// substitution is performed by the runtime before checking:
    ///   `${APP}`     — absolute path to the application bundle directory
    ///   `${APPDATA}` — platform app-data directory
    ///
    /// Example (`carbon.toml`):
    /// ```toml
    /// [app.capabilities]
    /// "image.read" = ["${APP}/assets/**", "${APPDATA}/cache/**"]
    /// ```
    ///
    /// Paths that don't match any glob are rejected with a `TypeError`
    /// from `__carbon_image_load_path`.
    #[serde(default, rename = "image.read")]
    pub image_read: Vec<String>,
}

impl Config {
    pub fn load(project_dir: &Path) -> Result<Self> {
        let path = project_dir.join("carbon.toml");
        let text =
            std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let cfg: Config =
            toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
        Ok(cfg)
    }
}

// ─── Plugins section ────────────────────────────────────────────────────
//
// carbon.toml's [plugins] table grants capabilities ONLY — it is not where
// a plugin is declared to exist. That's carbon/manifest.toml's job (see
// products/carbon/composition/manifest.rs's AppManifest), which
// plugin_loader.rs reads to get the actual set of plugins to load, resolving
// each to carbon/native/<os>/<arch>/<name>.<dll|so|dylib> by convention —
// no path ever appears in either file.
//
//     [plugins]
//     carbon-pulse = { capabilities = ["paint.pixmap"] }
//
// A plugin needing no capability needs no entry here at all — absence means
// zero grants, not "disabled" (disabling is a manifest.toml concern, an
// `enabled` field on the plugin's own entry there).

#[derive(Debug, Default, Deserialize)]
#[serde(transparent)]
pub struct PluginsSection(pub std::collections::BTreeMap<String, CapabilityGrant>);

impl PluginsSection {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &CapabilityGrant)> {
        self.0.iter()
    }
}

/// One plugin's capability grant. `[plugins.<name>] capabilities = [...]` —
/// no untagged-enum shorthand forms anymore, since there's nothing left to
/// shorthand: no path, no bool, just the one field a human ever hand-writes.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CapabilityGrant {
    /// Granted capability identifiers (e.g. `"audio.output"`, `"fs.read"`).
    /// The plugin's manifest declares its required capabilities; if any of
    /// those are NOT in this list the loader refuses to load the plugin.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Free-form JSON config object passed to the plugin via push_event
    /// at register time. Reserved for future use; plugins ignore it today.
    #[serde(default)]
    pub config: Option<toml::Value>,
}

// ─── App manifest (carbon/manifest.toml) ───────────────────────────────────
//
// The real source of truth for which plugins compose an app — NOT
// carbon.toml, which only grants capabilities (above) to names this
// declares. Generated/maintained by `carbon plugin new`/`add`/`enable`/
// `disable`; a human does not hand-edit it in normal use. Defined here
// (not beside its reader in products/carbon/composition/manifest.rs)
// because solutions/infrastructure/plugin-host's plugin_loader.rs needs it
// directly too, and a solution may not depend on a product.
#[derive(Debug, Default, Deserialize)]
pub struct AppManifest {
    #[serde(default)]
    pub plugins: std::collections::BTreeMap<String, AppManifestEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppManifestEntry {
    pub source: PluginSource,
    /// Skipped entirely by both `carbon/build.zig` (nothing built/staged)
    /// and the loader (nothing loaded) when false — the surviving disable
    /// toggle, flipped by `carbon plugin enable`/`disable` without touching
    /// the plugin's directory or this entry's other fields.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Vendor only, informational — nothing resolves against it.
    #[serde(default)]
    #[allow(dead_code)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginSource {
    Local,
    Vendor,
}
