// Most fields below are exposed on a public surface (e.g. LoadedPlugin.manifest)
// for diagnostic / introspection purposes; we don't actively read them inside
// this module today, but downstream tooling and tests will. Suppress the
// dead-code lint at module scope so that surface stays available.
#![allow(dead_code)]

// plugin_loader — discovery, validation, and lifecycle dispatch for native
// plugins matching the Carbon plugin C ABI v1 (see
// `ecosystem/users/sdk/include/carbon_plugin.h`).
//
// Pipeline per plugin:
//
//   carbon.toml [plugins]   →  PluginEntry
//        ↓
//   resolve path             →  <project_dir>/plugins/<name>.dll  (or override)
//        ↓
//   libloading::Library::new →  open the .dll / .so / .dylib
//        ↓
//   carbon_plugin_manifest() →  parse JSON, validate ABI major
//        ↓
//   capability check         →  required ⊆ granted (else refuse)
//        ↓
//   dlsym optional hooks     →  before_reload, after_reload, before_paint,
//                                after_paint, on_resize, on_shutdown
//        ↓
//   carbon_plugin_register() →  called once after JS context is ready
//
// Lifecycle hooks the runtime must invoke later (orchestrated from main.rs):
//
//   before_reload / after_reload  — wrap each HMR bundle re-eval
//   before_paint  / after_paint   — bracket each tiny-skia paint pass
//   on_resize                     — after WindowEvent::Resized updates dims
//   on_shutdown                   — once at app exit, before the Library is
//                                   dropped (and the DLL unloaded)

use crate::host_exports::{HostCarbonApp, CARBON_PLUGIN_ABI_VERSION_MAJOR};
use anyhow::{anyhow, Result};
use carbon_core::config::PluginEntry;
use libloading::{Library, Symbol};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};

// ── Plugin entry-point typedefs (mirroring carbon_plugin.h) ────────────────

type FnRegister = unsafe extern "C" fn(app: *mut HostCarbonApp);
type FnManifest = unsafe extern "C" fn() -> *const c_char;
type FnBeforeReload = unsafe extern "C" fn(app: *mut HostCarbonApp);
type FnAfterReload = unsafe extern "C" fn(app: *mut HostCarbonApp);
type FnBeforePaint = unsafe extern "C" fn(
    app: *mut HostCarbonApp,
    pixmap_data: *mut u8,
    width: u32,
    height: u32,
    stride_bytes: u32,
);
type FnAfterPaint = unsafe extern "C" fn(app: *mut HostCarbonApp);
type FnOnResize = unsafe extern "C" fn(app: *mut HostCarbonApp, w: u32, h: u32);
type FnOnShutdown = unsafe extern "C" fn(app: *mut HostCarbonApp);

// ── Manifest schema (subset we actually validate) ─────────────────────────
//
// Mirrors `carbon-plugin-sdk::Manifest`'s JSON shape but kept here as its own
// type so the loader doesn't pull in the SDK as a runtime dep.
#[derive(Debug, Deserialize, Default)]
pub struct ManifestCapabilities {
    #[serde(default)]
    pub required: Vec<String>,
    #[serde(default)]
    pub optional: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub abi_version_major: u32,
    #[serde(default)]
    pub abi_version_minor: u32,
    #[serde(default)]
    pub capabilities: ManifestCapabilities,
    #[serde(default)]
    pub modules: Vec<String>,
    #[serde(default)]
    pub lifecycle_hooks: Vec<String>,
}

// ── A single loaded plugin ────────────────────────────────────────────────
pub struct LoadedPlugin {
    pub name: String,
    pub manifest: Manifest,
    // The order matters: `library` MUST outlive the function pointers we
    // copied out of it. Drop order in Rust is field-declaration order,
    // top→bottom, so `register` etc. drop BEFORE `library`. Good.
    register: FnRegister,
    before_reload: Option<FnBeforeReload>,
    after_reload: Option<FnAfterReload>,
    before_paint: Option<FnBeforePaint>,
    after_paint: Option<FnAfterPaint>,
    on_resize: Option<FnOnResize>,
    on_shutdown: Option<FnOnShutdown>,
    // Held last so its drop runs last.
    _library: Library,
}

// ── Registry ──────────────────────────────────────────────────────────────
pub struct PluginRegistry {
    plugins: Vec<LoadedPlugin>,
    app: *mut HostCarbonApp,
}

// SAFETY: PluginRegistry holds a raw pointer to a HostCarbonApp pinned for
// the runtime's lifetime. We never mutate that pointer from another thread;
// dispatch is always done from the JS thread.
unsafe impl Send for PluginRegistry {}

impl PluginRegistry {
    pub fn new(app: *mut HostCarbonApp) -> Self {
        Self { plugins: Vec::new(), app }
    }

    /// Build a registry from carbon.toml [plugins] entries. Plugins that
    /// fail to load (file missing, manifest parse error, ABI mismatch,
    /// capability shortfall) are SKIPPED with a stderr log — they don't
    /// abort the runtime. This matches the existing audio/image bake-in
    /// behavior: missing capabilities degrade gracefully.
    pub fn load_from_config(
        entries: &BTreeMap<String, PluginEntry>,
        project_dir: &Path,
        app: *mut HostCarbonApp,
    ) -> Result<Self> {
        let mut registry = Self::new(app);
        for (name, entry) in entries {
            if !entry.enabled() {
                continue;
            }
            match load_one(name, entry, project_dir) {
                Ok(p) => {
                    eprintln!("[carbon-mini-plugin] loaded {}", p.name);
                    registry.plugins.push(p);
                }
                Err(e) => {
                    eprintln!(
                        "[carbon-mini-plugin] FAILED to load `{name}`: {e:#}\n  \
                         hint: check carbon.toml [plugins.{name}] capabilities and the dll path."
                    );
                }
            }
        }
        Ok(registry)
    }

    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    /// Call `carbon_plugin_register` on every plugin. Run after the JS
    /// context's `__carbon_on_event` dispatcher and any other host imports
    /// are in place — plugins typically install JS globals from inside.
    pub fn dispatch_register(&mut self) {
        for p in &self.plugins {
            // SAFETY: `app` is pinned for the runtime's lifetime; the
            // plugin's macro-generated trampoline catches panics across the
            // FFI boundary so an unwinding plugin can't take us down.
            unsafe { (p.register)(self.app) };
        }
    }

    pub fn dispatch_before_reload(&self) {
        for p in &self.plugins {
            if let Some(f) = p.before_reload {
                unsafe { f(self.app) };
            }
        }
    }

    pub fn dispatch_after_reload(&self) {
        for p in &self.plugins {
            if let Some(f) = p.after_reload {
                unsafe { f(self.app) };
            }
        }
    }

    pub fn dispatch_before_paint(
        &self,
        pixmap: &mut [u8],
        w: u32,
        h: u32,
        stride: u32,
    ) {
        for p in &self.plugins {
            if let Some(f) = p.before_paint {
                unsafe { f(self.app, pixmap.as_mut_ptr(), w, h, stride) };
            }
        }
    }

    pub fn dispatch_after_paint(&self) {
        for p in &self.plugins {
            if let Some(f) = p.after_paint {
                unsafe { f(self.app) };
            }
        }
    }

    pub fn dispatch_on_resize(&self, w: u32, h: u32) {
        for p in &self.plugins {
            if let Some(f) = p.on_resize {
                unsafe { f(self.app, w, h) };
            }
        }
    }

    /// Call `on_shutdown` on every plugin in REVERSE registration order,
    /// then drop the plugins (which closes their Library handles).
    pub fn dispatch_on_shutdown(&mut self) {
        for p in self.plugins.iter().rev() {
            if let Some(f) = p.on_shutdown {
                unsafe { f(self.app) };
            }
        }
        // Drop in reverse load order: Vec drains in load order, so reverse
        // first.
        let mut taken = std::mem::take(&mut self.plugins);
        while let Some(_p) = taken.pop() {
            // _p is dropped here, which drops _library → unloads the DLL.
        }
    }
}

// ── Per-plugin load steps ─────────────────────────────────────────────────

fn load_one(
    name: &str,
    entry: &PluginEntry,
    project_dir: &Path,
) -> Result<LoadedPlugin> {
    let path = resolve_plugin_path(name, entry, project_dir)?;
    eprintln!("[carbon-mini-plugin] loading `{name}` from {}", path.display());

    // SAFETY: libloading::Library::new is unsafe because loading arbitrary
    // user code can run static initializers that violate any invariant. The
    // user opting in via carbon.toml [plugins] is the consent gate.
    let library = unsafe { Library::new(&path) }
        .map_err(|e| anyhow!("dlopen {}: {e}", path.display()))?;

    // 1. Manifest — parse + validate ABI version.
    let manifest_fn: Symbol<'_, FnManifest> = unsafe {
        library
            .get(b"carbon_plugin_manifest\0")
            .map_err(|e| anyhow!("missing `carbon_plugin_manifest`: {e}"))?
    };
    let manifest_ptr = unsafe { manifest_fn() };
    if manifest_ptr.is_null() {
        return Err(anyhow!("`carbon_plugin_manifest` returned null"));
    }
    let manifest_json = unsafe { CStr::from_ptr(manifest_ptr) }
        .to_str()
        .map_err(|e| anyhow!("manifest is not valid UTF-8: {e}"))?;
    let manifest: Manifest = serde_json::from_str(manifest_json)
        .map_err(|e| anyhow!("manifest JSON parse: {e}\nraw: {manifest_json}"))?;

    if manifest.abi_version_major != CARBON_PLUGIN_ABI_VERSION_MAJOR {
        return Err(anyhow!(
            "ABI major mismatch: plugin requires v{} but runtime is v{}. \
             Recompile the plugin against the matching SDK version.",
            manifest.abi_version_major,
            CARBON_PLUGIN_ABI_VERSION_MAJOR,
        ));
    }

    // 2. Capability check — every required capability must be granted in
    //    the host's [plugins.<name>] capabilities = [...] list.
    let granted = entry.capabilities();
    let mut missing: Vec<&str> = Vec::new();
    for req in &manifest.capabilities.required {
        if !granted.iter().any(|g| g == req) {
            missing.push(req.as_str());
        }
    }
    if !missing.is_empty() {
        return Err(anyhow!(
            "plugin requires capabilities {missing:?} but [plugins.{name}] \
             only grants {granted:?}. Add them to carbon.toml:\n  \
             [plugins.{name}]\n  capabilities = [{}]",
            missing
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    // 3. Required entry point.
    let register_fn: Symbol<'_, FnRegister> = unsafe {
        library
            .get(b"carbon_plugin_register\0")
            .map_err(|e| anyhow!("missing `carbon_plugin_register`: {e}"))?
    };
    let register: FnRegister = *register_fn;

    // 4. Optional hooks. Each is dlsym'd; missing symbols are not an error.
    let before_reload = optional_sym::<FnBeforeReload>(&library, b"carbon_plugin_before_reload\0");
    let after_reload = optional_sym::<FnAfterReload>(&library, b"carbon_plugin_after_reload\0");
    let before_paint = optional_sym::<FnBeforePaint>(&library, b"carbon_plugin_before_paint\0");
    let after_paint = optional_sym::<FnAfterPaint>(&library, b"carbon_plugin_after_paint\0");
    let on_resize = optional_sym::<FnOnResize>(&library, b"carbon_plugin_on_resize\0");
    let on_shutdown = optional_sym::<FnOnShutdown>(&library, b"carbon_plugin_on_shutdown\0");

    // Drop the borrowed Symbol values (we copied the fn ptrs out) so we can
    // own the Library going forward.
    drop(manifest_fn);
    drop(register_fn);

    Ok(LoadedPlugin {
        name: manifest.name.clone(),
        manifest,
        register,
        before_reload,
        after_reload,
        before_paint,
        after_paint,
        on_resize,
        on_shutdown,
        _library: library,
    })
}

fn optional_sym<F: Copy>(library: &Library, name: &[u8]) -> Option<F> {
    let sym: Result<Symbol<'_, F>, _> = unsafe { library.get(name) };
    sym.ok().map(|s| *s)
}

/// Resolve `[plugins].<name> = <entry>` to an absolute filesystem path.
///
///   Bool(true)             → <project_dir>/plugins/<name>.<DLL_EXT>
///   Path("relative.dll")   → <project_dir>/relative.dll
///   Path("C:/abs/x.dll")   → C:/abs/x.dll  (absolute paths pass through)
///   Full { path: Some, .. }→ same as Path(...)
///   Full { path: None, .. }→ same as Bool(true)
fn resolve_plugin_path(
    name: &str,
    entry: &PluginEntry,
    project_dir: &Path,
) -> Result<PathBuf> {
    if let Some(p) = entry.path() {
        let pp = Path::new(p);
        let abs = if pp.is_absolute() {
            pp.to_path_buf()
        } else {
            project_dir.join(pp)
        };
        if !abs.exists() {
            return Err(anyhow!("explicit plugin path does not exist: {}", abs.display()));
        }
        return Ok(abs);
    }

    // Auto-resolve. Try platform-native dynamic library extensions in order.
    let exts: &[&str] = if cfg!(target_os = "windows") {
        &["dll"]
    } else if cfg!(target_os = "macos") {
        &["dylib", "so"]
    } else {
        &["so"]
    };
    let dir = project_dir.join("plugins");
    for ext in exts {
        // Plugin authors often use hyphens in names (`carbon-audio`) but Rust
        // cdylibs default to underscores (`carbon_audio.dll`). Try both.
        for variant in [name.to_string(), name.replace('-', "_"), name.replace('_', "-")] {
            let p = dir.join(format!("{variant}.{ext}"));
            if p.exists() {
                return Ok(p);
            }
            let p = dir.join(format!("lib{variant}.{ext}"));
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err(anyhow!(
        "could not auto-resolve plugin `{name}` — looked for {:?} in {}",
        exts,
        dir.display()
    ))
}

// Suppress unused-import warnings under cfgs that don't need c_void.
#[allow(dead_code)]
fn _force_use_c_void(_: *mut c_void) {}
