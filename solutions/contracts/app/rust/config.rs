// carbon.toml manifest parsing.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub app: AppSection,
    #[serde(default)]
    pub runtime: RuntimeSection,
    /// Native plugin grants. Keys are plugin names, values describe
    /// either a simple boolean grant, an explicit path, or a full record
    /// with capability grants. See [`PluginEntry`] for the accepted forms.
    ///
    /// Plugin loading is driven by `carbon/api/plugin_loader.rs`.
    /// If this section is missing or empty the loader is a no-op.
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
// Three accepted forms in carbon.toml:
//
//     [plugins]
//     audio  = true                                    # bool — auto-resolve path
//     image  = "plugins/carbon-image.dll"              # explicit path (relative to project_dir)
//     canvas = { path = "...", capabilities = ["gpu"] } # full form
//
// Note this section is ADDITIVE — the existing `[runtime] audio = true /
// image = true` flags continue to drive the bake-in path. Once Agent 4
// migrates the bake-in implementations into plugins, those flags can be
// removed and this section becomes the canonical source of truth.

#[derive(Debug, Default, Deserialize)]
#[serde(transparent)]
pub struct PluginsSection(pub std::collections::BTreeMap<String, PluginEntry>);

impl PluginsSection {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &PluginEntry)> {
        self.0.iter()
    }
}

/// Per-plugin entry in `[plugins]`. The TOML deserializer uses untagged
/// variants — try Bool, then Path (string), then the full table form.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PluginEntry {
    /// `name = true` — auto-resolve `<project_dir>/plugins/<name>.<dll|so|dylib>`.
    /// `name = false` — disabled, ignored entirely.
    Bool(bool),
    /// `name = "path/to/plugin.dll"` — explicit path resolved relative to
    /// the project_dir. Absolute paths are also accepted.
    Path(String),
    /// `name = { path = "...", capabilities = [...] }` — full form.
    Full(PluginEntryFull),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PluginEntryFull {
    /// Override the auto-resolved path. None ⇒ use the auto-resolution
    /// rule (same as `name = true`).
    #[serde(default)]
    pub path: Option<String>,
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

impl PluginEntry {
    /// Whether this entry indicates the plugin should actually be loaded.
    /// `false` for `name = false`, true otherwise.
    pub fn enabled(&self) -> bool {
        match self {
            PluginEntry::Bool(b) => *b,
            PluginEntry::Path(_) => true,
            PluginEntry::Full(_) => true,
        }
    }

    /// User-supplied path override, if any.
    pub fn path(&self) -> Option<&str> {
        match self {
            PluginEntry::Bool(_) => None,
            PluginEntry::Path(p) => Some(p.as_str()),
            PluginEntry::Full(f) => f.path.as_deref(),
        }
    }

    /// Granted capabilities for this plugin (empty for short-form variants).
    pub fn capabilities(&self) -> &[String] {
        match self {
            PluginEntry::Bool(_) => &[],
            PluginEntry::Path(_) => &[],
            PluginEntry::Full(f) => &f.capabilities,
        }
    }
}
