// Most fields below are exposed on a public surface (e.g. LoadedPlugin.manifest)
// for diagnostic / introspection purposes; we don't actively read them inside
// this module today, but downstream tooling and tests will. Suppress the
// dead-code lint at module scope so that surface stays available.
#![allow(dead_code)]

// plugin_loader — discovery, validation, and extension-point dispatch for
// native plugins matching the Carbon plugin C ABI v1.
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
//   BIND EXTENSION POINTS    →  for every point in the registry, dlsym its
//                                symbol; a resolved symbol is an implemented
//                                point. Per-point capability and exclusivity
//                                are enforced here.
//        ↓
//   lifecycle.register       →  called once after the JS context is ready
//
// ── WHY THE POINTS ARE A TABLE AND NOT A LIST OF FIELDS ────────────────────
// This used to hold seven named `Option<FnBeforePaint>`-style fields, one per
// hook, and every one of the symbol names was written out by hand next to a
// hand-written `unsafe extern "C" fn` type. Three copies of one agreement —
// here, the C header, and each SDK — kept in step by nobody.
//
// Now `carbon_plugin_contract::POINTS` is generated from
// `solutions/contracts/plugin/registry/extension-points.zig`, this walks it,
// and the fn types the symbols are transmuted into come from the same
// generator that produced the prototypes the plugin compiled against. Adding a
// point is an edit to the Zig and a regenerate; this file does not change
// until the runtime decides to CALL the new point.

use crate::host_exports::{HostCarbonApp, CARBON_PLUGIN_ABI_VERSION_MAJOR};
use anyhow::{anyhow, Result};
use carbon_core::config::PluginEntry;
use carbon_plugin_contract::{self as contract, Arity, CarbonApp, PointId, Stability, POINTS};
use libloading::{Library, Symbol};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};

// ── Manifest schema (subset we actually validate) ─────────────────────────
//
// Mirrors the JSON shape the Zig SDK's manifest builder emits, kept here as
// its own type so the loader doesn't pull in the SDK as a runtime dep.
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
    /// The points this plugin claims to implement.
    ///
    /// Advisory rather than authoritative: what a plugin ACTUALLY implements is
    /// which symbols it exports, and that is what gets bound. This list is
    /// checked against the bound set so a plugin that declares a point it did
    /// not export — a typo'd `export fn`, the commonest Zig plugin bug — is
    /// told so at load time instead of silently never being called.
    #[serde(default)]
    pub extension_points: Vec<String>,
    /// Pre-registry name for the same field. Manifests written against ABI 1.0
    /// use it, and they are in the wild.
    #[serde(default)]
    pub lifecycle_hooks: Vec<String>,
}

/// An untyped plugin entry point. Every bound symbol is stored as one of these
/// and transmuted to the point's real signature at the dispatch site.
type RawFn = unsafe extern "C" fn();

// ── A single loaded plugin ────────────────────────────────────────────────
pub struct LoadedPlugin {
    pub name: String,
    pub manifest: Manifest,
    /// Which points this plugin implements, keyed by the generated `PointId`.
    ///
    /// The order matters below: `bound` MUST drop before `_library`, because
    /// these are function pointers INTO that library. Rust drops fields in
    /// declaration order, top to bottom.
    bound: BTreeMap<PointId, RawFn>,
    // Held last so its drop runs last.
    _library: Library,
}

impl LoadedPlugin {
    pub fn implements(&self, point: PointId) -> bool {
        self.bound.contains_key(&point)
    }

    /// Every point this plugin implements, for `carbon plugin info`.
    pub fn points(&self) -> impl Iterator<Item = PointId> + '_ {
        self.bound.keys().copied()
    }

    fn get(&self, point: PointId) -> Option<RawFn> {
        self.bound.get(&point).copied()
    }
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
        Self {
            plugins: Vec::new(),
            app,
        }
    }

    /// The host descriptor as the generated signatures spell it.
    ///
    /// `HostCarbonApp` is this crate's concrete `#[repr(C)]` struct;
    /// `contract::CarbonApp` is the contract's opaque one. They are the same
    /// allocation — the contract may not name an implementation, so the cast
    /// happens here, once, at the only place both types are in scope.
    fn app_ptr(&self) -> *mut CarbonApp {
        self.app.cast()
    }

    /// Build a registry from carbon.toml [plugins] entries. Plugins that
    /// fail to load (file missing, manifest parse error, ABI mismatch,
    /// capability shortfall) are SKIPPED with a stderr log — they don't
    /// abort the runtime.
    pub fn load_from_config(
        entries: &BTreeMap<String, PluginEntry>,
        project_dir: &Path,
        app: *mut HostCarbonApp,
    ) -> Result<Self> {
        let mut registry = Self::new(app);
        // Which plugin claimed each exclusive point, so the second claimant can
        // be refused BY NAME rather than losing to load order.
        let mut exclusive_claims: BTreeMap<PointId, String> = BTreeMap::new();

        for (name, entry) in entries {
            if !entry.enabled() {
                continue;
            }
            match load_one(name, entry, project_dir, &mut exclusive_claims) {
                Ok(p) => {
                    let points: Vec<&str> = p.points().map(PointId::as_str).collect();
                    eprintln!(
                        "[carbon-plugin] loaded {} — implements [{}]",
                        p.name,
                        points.join(", ")
                    );
                    registry.plugins.push(p);
                }
                Err(e) => {
                    eprintln!(
                        "[carbon-plugin] FAILED to load `{name}`: {e:#}\n  \
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

    /// How many loaded plugins implement a point. The runtime uses it to skip
    /// per-frame dispatch work entirely when nothing is listening.
    pub fn implementor_count(&self, point: PointId) -> usize {
        self.plugins.iter().filter(|p| p.implements(point)).count()
    }

    /// Every bound function for `point`, in load order.
    ///
    /// # Safety
    /// The caller transmutes each `RawFn` to the signature the registry
    /// declares for `point`, and to nothing else.
    unsafe fn bound(&self, point: PointId) -> impl Iterator<Item = RawFn> + '_ {
        self.plugins.iter().filter_map(move |p| p.get(point))
    }

    // ── Dispatch ──────────────────────────────────────────────────────────
    //
    // One method per point the runtime actually calls. Each transmutes to the
    // GENERATED signature for that point, so a change to the registry that
    // alters a signature turns into a compile error here rather than a
    // mismatched call at runtime.

    /// `lifecycle.register`. Run after the JS context's dispatchers and host
    /// imports are in place — plugins typically install JS globals inside.
    pub fn dispatch_register(&mut self) {
        for f in unsafe { self.bound(PointId::LifecycleRegister) } {
            let f: contract::LifecycleRegisterFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr()) };
        }
    }

    /// `lifecycle.before_bundle_eval`.
    pub fn dispatch_before_bundle_eval(&self) {
        for f in unsafe { self.bound(PointId::LifecycleBeforeBundleEval) } {
            let f: contract::LifecycleBeforeBundleEvalFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr()) };
        }
    }

    /// `lifecycle.before_reload`.
    pub fn dispatch_before_reload(&self) {
        for f in unsafe { self.bound(PointId::LifecycleBeforeReload) } {
            let f: contract::LifecycleBeforeReloadFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr()) };
        }
    }

    /// `lifecycle.after_reload`.
    pub fn dispatch_after_reload(&self) {
        for f in unsafe { self.bound(PointId::LifecycleAfterReload) } {
            let f: contract::LifecycleAfterReloadFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr()) };
        }
    }

    /// `paint.before`.
    pub fn dispatch_before_paint(&self, pixmap: &mut [u8], w: u32, h: u32, stride: u32) {
        for f in unsafe { self.bound(PointId::PaintBefore) } {
            let f: contract::PaintBeforeFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr(), pixmap.as_mut_ptr(), w, h, stride) };
        }
    }

    /// `paint.after`.
    pub fn dispatch_after_paint(&self) {
        for f in unsafe { self.bound(PointId::PaintAfter) } {
            let f: contract::PaintAfterFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr()) };
        }
    }

    /// `window.resized`.
    pub fn dispatch_on_resize(&self, w: u32, h: u32) {
        for f in unsafe { self.bound(PointId::WindowResized) } {
            let f: contract::WindowResizedFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr(), w, h) };
        }
    }

    /// `window.theme_changed`.
    pub fn dispatch_theme_changed(&self, is_dark: bool) {
        for f in unsafe { self.bound(PointId::WindowThemeChanged) } {
            let f: contract::WindowThemeChangedFn = unsafe { std::mem::transmute(f) };
            unsafe { f(self.app_ptr(), i32::from(is_dark)) };
        }
    }

    /// `host.resolve_asset` — exclusive, so at most one plugin answers.
    ///
    /// Returns `None` when nothing implements it or the implementor declined,
    /// which is the runtime's signal to carry on failing the way it would have.
    pub fn dispatch_resolve_asset(&self, request: &CStr) -> Option<i32> {
        let f = unsafe { self.bound(PointId::HostResolveAsset) }.next()?;
        let f: contract::HostResolveAssetFn = unsafe { std::mem::transmute(f) };
        let status = unsafe { f(self.app_ptr(), request.as_ptr()) };
        (status == 0).then_some(status)
    }

    /// `lifecycle.shutdown`, in REVERSE registration order, then drop the
    /// plugins (which closes their Library handles).
    pub fn dispatch_on_shutdown(&mut self) {
        for plugin in self.plugins.iter().rev() {
            if let Some(f) = plugin.get(PointId::LifecycleShutdown) {
                let f: contract::LifecycleShutdownFn = unsafe { std::mem::transmute(f) };
                unsafe { f(self.app_ptr()) };
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
    exclusive_claims: &mut BTreeMap<PointId, String>,
) -> Result<LoadedPlugin> {
    let path = resolve_plugin_path(name, entry, project_dir)?;
    eprintln!("[carbon-plugin] loading `{name}` from {}", path.display());

    // SAFETY: libloading::Library::new is unsafe because loading arbitrary
    // user code can run static initializers that violate any invariant. The
    // user opting in via carbon.toml [plugins] is the consent gate.
    let library =
        unsafe { Library::new(&path) }.map_err(|e| anyhow!("dlopen {}: {e}", path.display()))?;

    // 1. Manifest — parse + validate ABI major.
    let manifest = read_manifest(&library)?;
    if manifest.abi_version_major != CARBON_PLUGIN_ABI_VERSION_MAJOR {
        return Err(anyhow!(
            "ABI major mismatch: plugin requires v{} but runtime is v{}. \
             Recompile the plugin against the matching SDK version.",
            manifest.abi_version_major,
            CARBON_PLUGIN_ABI_VERSION_MAJOR,
        ));
    }

    // 2. Whole-plugin capability check — every capability the manifest calls
    //    required must be granted, whatever the points say.
    let granted = entry.capabilities();
    let missing: Vec<&str> = manifest
        .capabilities
        .required
        .iter()
        .map(String::as_str)
        .filter(|req| !granted.iter().any(|g| g == req))
        .collect();
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

    // 3. Bind extension points. A resolved symbol IS an implemented point —
    //    the manifest's list is cross-checked below but is not what binds.
    let mut bound: BTreeMap<PointId, RawFn> = BTreeMap::new();
    for spec in POINTS.iter() {
        let Some(f) = optional_sym::<RawFn>(&library, spec.symbol) else {
            continue;
        };

        // Per-point capability. Finer-grained than the manifest's blanket
        // `required` list: a plugin that exports `carbon_plugin_before_paint`
        // is asking to write the framebuffer whether or not it said so.
        if let Some(capability) = spec.capability {
            if !granted.iter().any(|g| g == capability) {
                return Err(anyhow!(
                    "plugin implements `{}`, which needs the `{capability}` capability, \
                     but [plugins.{name}] grants {granted:?}.\n  \
                     Add it to carbon.toml:\n    [plugins.{name}]\n    \
                     capabilities = [\"{capability}\"]",
                    spec.id.as_str(),
                ));
            }
        }

        // Exclusive points: first loaded wins, and the second is refused with
        // the name of the one that has it. Silently picking one would make the
        // behaviour depend on BTreeMap iteration order of carbon.toml keys.
        if spec.arity == Arity::Exclusive {
            if let Some(holder) = exclusive_claims.get(&spec.id) {
                return Err(anyhow!(
                    "`{}` is an exclusive extension point and `{holder}` already implements it. \
                     Disable one of the two in carbon.toml [plugins].",
                    spec.id.as_str(),
                ));
            }
            exclusive_claims.insert(spec.id, name.to_string());
        }

        if spec.stability == Stability::Experimental {
            eprintln!(
                "[carbon-plugin] WARNING: `{name}` implements `{}`, which is EXPERIMENTAL \
                 and may change or disappear within ABI major {CARBON_PLUGIN_ABI_VERSION_MAJOR}.",
                spec.id.as_str(),
            );
        }

        bound.insert(spec.id, f);
    }

    // 4. Cross-check the manifest's claims against what was actually bound.
    //    Declared-but-absent is the commonest plugin bug — a typo in an
    //    `export fn` name compiles cleanly and produces a plugin that loads and
    //    does nothing.
    let declared = manifest
        .extension_points
        .iter()
        .chain(manifest.lifecycle_hooks.iter());
    for id in declared {
        match PointId::parse(id) {
            None => eprintln!(
                "[carbon-plugin] `{name}` declares `{id}`, which this runtime's registry \
                 does not have — built against a newer SDK? It will not be called."
            ),
            Some(point) if !bound.contains_key(&point) => eprintln!(
                "[carbon-plugin] `{name}` declares `{id}` but does not export `{}` — \
                 check the `export fn` name. It will not be called.",
                point.spec().symbol_str(),
            ),
            Some(_) => {}
        }
    }

    if bound.is_empty() {
        return Err(anyhow!(
            "plugin exports no extension point at all — it would load and do nothing. \
             At minimum, export `carbon_plugin_register`."
        ));
    }

    Ok(LoadedPlugin {
        name: manifest.name.clone(),
        manifest,
        bound,
        _library: library,
    })
}

fn read_manifest(library: &Library) -> Result<Manifest> {
    type FnManifest = unsafe extern "C" fn() -> *const c_char;

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

    serde_json::from_str(manifest_json)
        .map_err(|e| anyhow!("manifest JSON parse: {e}\nraw: {manifest_json}"))
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
fn resolve_plugin_path(name: &str, entry: &PluginEntry, project_dir: &Path) -> Result<PathBuf> {
    if let Some(p) = entry.path() {
        let pp = Path::new(p);
        let abs = if pp.is_absolute() {
            pp.to_path_buf()
        } else {
            project_dir.join(pp)
        };
        if !abs.exists() {
            return Err(anyhow!(
                "explicit plugin path does not exist: {}",
                abs.display()
            ));
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
        // Plugin authors often use hyphens in names (`carbon-audio`) but a Zig
        // shared library keeps the name it was given in build.zig, which may
        // use either. Try both, plus the `lib` prefix Unix linkers add.
        for variant in [
            name.to_string(),
            name.replace('-', "_"),
            name.replace('_', "-"),
        ] {
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
