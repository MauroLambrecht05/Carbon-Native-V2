//! Plugin manifest types + capability identifiers.
//!
//! A plugin's `carbon_plugin_manifest()` must return a JSON document matching
//! the schema in `include/carbon_plugin.h`. Rather than have plugin authors
//! hand-write that JSON, this module provides a typed builder.
//!
//! Example:
//! ```no_run
//! use carbon_plugin_sdk::capability::{Manifest, Capability};
//!
//! let m = Manifest::new("hello", "0.1.0")
//!     .require_abi(1, 0)
//!     .require_capability(Capability::FsRead)
//!     .module("carbon:hello");
//!
//! let json = m.to_json();
//! ```

use serde::{Deserialize, Serialize};

/// Stable capability identifiers. These map 1:1 to strings in the manifest
/// JSON (kebab-case via the `as_str` helper). Adding a variant is safe;
/// renaming or removing one is a breaking change for any plugin compiled
/// against this SDK.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    /// Read files within the app's granted glob set.
    FsRead,
    /// Write files within the app's granted glob set.
    FsWrite,
    /// Open the system audio output device.
    AudioOutput,
    /// Open the system audio input (microphone) device.
    AudioInput,
    /// Decode images via the carbon-image plugin (or equivalent).
    ImageDecode,
    /// GPU access (wgpu / D3D / Metal / Vulkan).
    Gpu,
    /// Outbound HTTP / network sockets.
    Network,
    /// System notifications, dialogs, tray icons.
    SystemUi,
    /// Read clipboard contents.
    ClipboardRead,
    /// Write clipboard contents.
    ClipboardWrite,
    /// Custom capability identifier (e.g., for third-party plugins). Use
    /// reverse-DNS-style names: "com.example.my-cap".
    Custom(&'static str),
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::FsRead => "fs.read",
            Capability::FsWrite => "fs.write",
            Capability::AudioOutput => "audio.output",
            Capability::AudioInput => "audio.input",
            Capability::ImageDecode => "image.decode",
            Capability::Gpu => "gpu",
            Capability::Network => "network",
            Capability::SystemUi => "system.ui",
            Capability::ClipboardRead => "clipboard.read",
            Capability::ClipboardWrite => "clipboard.write",
            Capability::Custom(s) => s,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional: Vec<String>,
}

impl Default for ManifestCapabilities {
    fn default() -> Self {
        Self { required: Vec::new(), optional: Vec::new() }
    }
}

/// Typed builder for the JSON manifest returned by `carbon_plugin_manifest`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub abi_version_major: u32,
    pub abi_version_minor: u32,

    #[serde(default)]
    pub capabilities: ManifestCapabilities,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<String>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lifecycle_hooks: Vec<String>,
}

impl Manifest {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
            abi_version_major: crate::ffi::CARBON_PLUGIN_ABI_VERSION_MAJOR,
            abi_version_minor: crate::ffi::CARBON_PLUGIN_ABI_VERSION_MINOR,
            capabilities: ManifestCapabilities::default(),
            modules: Vec::new(),
            lifecycle_hooks: Vec::new(),
        }
    }

    /// Override the ABI version this plugin requires. Defaults to the SDK's
    /// compiled-in version, which is almost always what you want.
    pub fn require_abi(mut self, major: u32, minor: u32) -> Self {
        self.abi_version_major = major;
        self.abi_version_minor = minor;
        self
    }

    pub fn require_capability(mut self, cap: Capability) -> Self {
        self.capabilities.required.push(cap.as_str().to_string());
        self
    }

    pub fn optional_capability(mut self, cap: Capability) -> Self {
        self.capabilities.optional.push(cap.as_str().to_string());
        self
    }

    /// Declare a JS module name this plugin exports — e.g. `"carbon:audio"`.
    /// The carbon-fast-import build plugin can resolve `import "carbon:audio"`
    /// to a stub that talks to this plugin's installed globals.
    pub fn module(mut self, name: impl Into<String>) -> Self {
        self.modules.push(name.into());
        self
    }

    /// Declare which lifecycle hooks this plugin actually implements.
    /// Carbon-mini still dlsym's each name; this list is informational
    /// (e.g., for `carbon plugin info`).
    pub fn hook(mut self, name: impl Into<String>) -> Self {
        self.lifecycle_hooks.push(name.into());
        self
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("manifest serialization is infallible")
    }

    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self)
            .expect("manifest serialization is infallible")
    }
}
