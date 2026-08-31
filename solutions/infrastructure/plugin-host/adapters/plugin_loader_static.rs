// plugin_loader (static-plugins build) — the release-build counterpart to
// adapters/plugin_loader.rs's dlopen/dlsym pipeline.
//
// lib.rs picks ONE of these two files to compile as the crate's
// `plugin_loader` module, selected by the `static-plugins` Cargo feature —
// never both. `carbon dev` and a standalone `carbon plugin build` always
// compile the OTHER file (today's dynamic dlopen/Ed25519/dlsym pipeline,
// completely unchanged); this one only exists in a `carbon build --release`
// runtime binary that `StaticLinkPluginsUseCase.ts` built a matching
// umbrella for.
//
// ── WHY THIS FILE CAN BE THIS SHORT ─────────────────────────────────────────
// Every check the dynamic loader does at every app launch — Ed25519 signature
// + revocation (`verify_with_trust_anchors`), ABI major match, required-
// capability-subset-of-granted, exclusive-arity double-claim, declared-vs-
// bound cross-check — happened ONCE already, at build time, in
// `StaticLinkPluginsUseCase.ts`, against the exact same `carbon-plugin.toml`
// files the dynamic loader would have read. A plugin that failed any of
// those checks was never linked into this binary in the first place, so
// there is nothing left to verify at startup. See
// `.local/notes/roadmap/04-security-and-capabilities/README.md` Layer 0:
// "every layer sits at install, build, or publish time... never the runtime
// hot path" — this moves the LAST plugin-related check that used to run on
// every launch to build time too.
//
// Signing specifically is not just moved but dropped: the question Ed25519
// verification answers — "should this runtime trust a binary someone else
// produced, at the moment of loading it on an end user's machine" — does not
// apply to code that was compiled into this exact binary in this exact
// build, from the same source tree (first-party `products/carbon-sdk/*`, or
// an app author's own `carbon/plugins/local/*`) the rest of the app already
// implicitly trusts. The runtime never signature-checks its own Rust crates
// or the app's JS bundle either. The single resulting executable is still
// whole-binary code-signed by the existing packaging pipeline
// (AuthenticodeSigner.ts / MacOsSigner.ts) — that is the trust boundary that
// matters here, same as for every other statically-linked dependency in any
// framework.
//
// ── THE CONTRACT WITH THE GENERATED UMBRELLA ────────────────────────────────
// The `extern "C"` block below declares all 10 registry points (plus one
// meta symbol, `carbon_plugin_static_count`) UNCONDITIONALLY — every
// `carbon build --release` runtime binary expects exactly these 11 symbols
// to exist, regardless of which plugins an app actually enabled. The
// generated umbrella (`StaticLinkPluginsUseCase.ts`) is responsible for
// always emitting all 11, using a no-op body (matching the point's real
// return type — `void` for most, `0`/CARBON_OK-shaped for
// `host.resolve_asset`) for any point no enabled plugin implements. This
// keeps this file — and the extern declarations, which are exactly the
// symbol names/signatures `solutions/contracts/plugin/registry/
// extension-points.zig` already defines — free of per-app variation: what
// varies between apps is which plugins the umbrella fans out to internally,
// never what the Rust host calls.

use crate::host_exports::HostCarbonApp;
use anyhow::Result;
use carbon_core::config::{AppManifest, CapabilityGrant};
use carbon_plugin_contract::{CarbonApp, PointId};
use std::collections::BTreeMap;
use std::ffi::{c_char, CStr};
use std::path::Path;

unsafe extern "C" {
    fn carbon_plugin_register(app: *mut CarbonApp);
    fn carbon_ext_lifecycle_before_bundle_eval(app: *mut CarbonApp);
    fn carbon_plugin_before_reload(app: *mut CarbonApp);
    fn carbon_plugin_after_reload(app: *mut CarbonApp);
    fn carbon_plugin_on_shutdown(app: *mut CarbonApp);
    fn carbon_plugin_before_paint(
        app: *mut CarbonApp,
        pixmap: *mut u8,
        width: u32,
        height: u32,
        stride_bytes: u32,
    );
    fn carbon_plugin_after_paint(app: *mut CarbonApp);
    fn carbon_plugin_on_resize(app: *mut CarbonApp, width: u32, height: u32);
    fn carbon_ext_window_theme_changed(app: *mut CarbonApp, is_dark: i32);
    fn carbon_ext_host_resolve_asset(app: *mut CarbonApp, request: *const c_char) -> i32;
    /// Not a registry point — how many plugins the umbrella actually linked,
    /// baked in at umbrella-generation time. Purely informational (today's
    /// only reader is `mini.rs`'s startup timing log); nothing branches on
    /// it.
    fn carbon_plugin_static_count() -> u32;
}

pub struct PluginRegistry {
    app: *mut HostCarbonApp,
}

// SAFETY: same reasoning as the dynamic PluginRegistry (adapters/
// plugin_loader.rs) — the pointer is pinned for the runtime's lifetime and
// dispatch always happens from the JS thread.
unsafe impl Send for PluginRegistry {}

impl PluginRegistry {
    pub fn new(app: *mut HostCarbonApp) -> Self {
        Self { app }
    }

    /// Signature-compatible with the dynamic loader's `load_from_config` on
    /// purpose — `mini.rs`'s call site does not (and should not) need to
    /// know which of the two `plugin_loader` modules it was compiled
    /// against. Every parameter but `app` is unused: which plugins are
    /// "loaded" was decided, validated, and linked in at build time, not
    /// something this runtime discovers from `carbon/manifest.toml` at
    /// startup.
    pub fn load_from_config(
        _manifest: &AppManifest,
        _grants: &BTreeMap<String, CapabilityGrant>,
        _dev_trusted_keys: &[String],
        _project_dir: &Path,
        app: *mut HostCarbonApp,
    ) -> Result<Self> {
        Ok(Self::new(app))
    }

    fn app_ptr(&self) -> *mut CarbonApp {
        self.app.cast()
    }

    /// How many plugins are statically linked into this binary. Mirrors the
    /// dynamic loader's method name/shape; `mini.rs`'s only use of it today
    /// is a startup timing-log gate, not a functional branch.
    pub fn plugin_count(&self) -> usize {
        (unsafe { carbon_plugin_static_count() }) as usize
    }

    /// Not meaningful per-point once linking happened at build time (the
    /// umbrella's no-op stubs make every point "implemented" in the sense
    /// this API can observe from Rust) — kept only so code written against
    /// the dynamic `PluginRegistry`'s public API still compiles unchanged
    /// against this one. Nothing in the runtime currently calls it (checked:
    /// same as upstream, dead outside plugin_loader itself).
    pub fn implementor_count(&self, _point: PointId) -> usize {
        self.plugin_count()
    }

    pub fn dispatch_register(&mut self) {
        unsafe { carbon_plugin_register(self.app_ptr()) };
    }

    pub fn dispatch_before_bundle_eval(&self) {
        unsafe { carbon_ext_lifecycle_before_bundle_eval(self.app_ptr()) };
    }

    pub fn dispatch_before_reload(&self) {
        unsafe { carbon_plugin_before_reload(self.app_ptr()) };
    }

    pub fn dispatch_after_reload(&self) {
        unsafe { carbon_plugin_after_reload(self.app_ptr()) };
    }

    pub fn dispatch_before_paint(&self, pixmap: &mut [u8], w: u32, h: u32, stride: u32) {
        unsafe { carbon_plugin_before_paint(self.app_ptr(), pixmap.as_mut_ptr(), w, h, stride) };
    }

    pub fn dispatch_after_paint(&self) {
        unsafe { carbon_plugin_after_paint(self.app_ptr()) };
    }

    pub fn dispatch_on_resize(&self, w: u32, h: u32) {
        unsafe { carbon_plugin_on_resize(self.app_ptr(), w, h) };
    }

    pub fn dispatch_theme_changed(&self, is_dark: bool) {
        unsafe { carbon_ext_window_theme_changed(self.app_ptr(), i32::from(is_dark)) };
    }

    /// Declared for API parity with the dynamic loader; genuinely unused
    /// there too (see plugin_loader.rs's own doc comment: "NOT YET
    /// DISPATCHED", `host.resolve_asset` is experimental and nothing in
    /// products/carbon calls this dynamic-side method either).
    pub fn dispatch_resolve_asset(&self, request: &CStr) -> Option<i32> {
        let status = unsafe { carbon_ext_host_resolve_asset(self.app_ptr(), request.as_ptr()) };
        (status == 0).then_some(status)
    }

    pub fn dispatch_on_shutdown(&mut self) {
        unsafe { carbon_plugin_on_shutdown(self.app_ptr()) };
    }
}
