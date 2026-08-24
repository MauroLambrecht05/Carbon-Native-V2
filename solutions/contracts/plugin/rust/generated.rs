// GENERATED — DO NOT EDIT.
//
// Source of truth: solutions/contracts/plugin/registry/extension-points.zig
// Regenerate:      carbon ext generate
// Verified by:     .tools/validation/check_extension_points.py

// The extension points a plugin may implement, as data the loader walks.
//
// `PointId` is `#[non_exhaustive]`-shaped in spirit but not in attribute: the
// runtime matches on it exhaustively on purpose, so that appending a point to
// the registry produces a compile error at every place that decides what to do
// with one. A silently-ignored new point is the failure this table exists to
// prevent.

use core::ffi::c_char;

use crate::CarbonApp;

/// The ABI minor implied by the registry — the highest `since_minor` in it.
pub const EXTENSION_POINTS_MINOR: u32 = 1;

/// How many plugins may implement one point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arity {
    /// Every implementor is called, in load order.
    Many,
    /// At most one plugin may implement it; the loader refuses the second.
    Exclusive,
}

/// What a plugin author may rely on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stability {
    Stable,
    /// May change within an ABI major. The loader warns on use.
    Experimental,
}

/// Every point in the registry, in declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PointId {
    /// `lifecycle.register`
    LifecycleRegister,
    /// `lifecycle.before_bundle_eval`
    LifecycleBeforeBundleEval,
    /// `lifecycle.before_reload`
    LifecycleBeforeReload,
    /// `lifecycle.after_reload`
    LifecycleAfterReload,
    /// `lifecycle.shutdown`
    LifecycleShutdown,
    /// `paint.before`
    PaintBefore,
    /// `paint.after`
    PaintAfter,
    /// `window.resized`
    WindowResized,
    /// `window.theme_changed`
    WindowThemeChanged,
    /// `host.resolve_asset`
    HostResolveAsset,
}

impl PointId {
    /// The id as written in a plugin manifest.
    pub const fn as_str(self) -> &'static str {
        match self {
            PointId::LifecycleRegister => "lifecycle.register",
            PointId::LifecycleBeforeBundleEval => "lifecycle.before_bundle_eval",
            PointId::LifecycleBeforeReload => "lifecycle.before_reload",
            PointId::LifecycleAfterReload => "lifecycle.after_reload",
            PointId::LifecycleShutdown => "lifecycle.shutdown",
            PointId::PaintBefore => "paint.before",
            PointId::PaintAfter => "paint.after",
            PointId::WindowResized => "window.resized",
            PointId::WindowThemeChanged => "window.theme_changed",
            PointId::HostResolveAsset => "host.resolve_asset",
        }
    }

    /// Resolve a manifest string to a point. `None` means the plugin was
    /// built against a registry this runtime does not have.
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "lifecycle.register" => Some(PointId::LifecycleRegister),
            "lifecycle.before_bundle_eval" => Some(PointId::LifecycleBeforeBundleEval),
            "lifecycle.before_reload" => Some(PointId::LifecycleBeforeReload),
            "lifecycle.after_reload" => Some(PointId::LifecycleAfterReload),
            "lifecycle.shutdown" => Some(PointId::LifecycleShutdown),
            "paint.before" => Some(PointId::PaintBefore),
            "paint.after" => Some(PointId::PaintAfter),
            "window.resized" => Some(PointId::WindowResized),
            "window.theme_changed" => Some(PointId::WindowThemeChanged),
            "host.resolve_asset" => Some(PointId::HostResolveAsset),
            _ => None,
        }
    }

    /// The row describing this point.
    pub fn spec(self) -> &'static PointSpec {
        &POINTS[self as usize]
    }
}

/// One row of the registry.
#[derive(Debug)]
pub struct PointSpec {
    pub id: PointId,
    /// The exported symbol the loader resolves. NUL-terminated so it can go
    /// straight to `libloading::Library::get` without an allocation.
    pub symbol: &'static [u8],
    pub since_minor: u32,
    pub stability: Stability,
    pub arity: Arity,
    /// Capability the host app must grant before a plugin implementing this
    /// point will load. `None` means the point only observes.
    pub capability: Option<&'static str>,
}

/// Indexed by `PointId as usize` — `PointId::spec` relies on that, and the
/// generator emits the rows in enum order to keep it true.
pub static POINTS: [PointSpec; 10] = [
    PointSpec {
        id: PointId::LifecycleRegister,
        symbol: b"carbon_plugin_register\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::LifecycleBeforeBundleEval,
        symbol: b"carbon_ext_lifecycle_before_bundle_eval\0",
        since_minor: 1,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::LifecycleBeforeReload,
        symbol: b"carbon_plugin_before_reload\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::LifecycleAfterReload,
        symbol: b"carbon_plugin_after_reload\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::LifecycleShutdown,
        symbol: b"carbon_plugin_on_shutdown\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::PaintBefore,
        symbol: b"carbon_plugin_before_paint\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: Some("paint.pixmap"),
    },
    PointSpec {
        id: PointId::PaintAfter,
        symbol: b"carbon_plugin_after_paint\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::WindowResized,
        symbol: b"carbon_plugin_on_resize\0",
        since_minor: 0,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::WindowThemeChanged,
        symbol: b"carbon_ext_window_theme_changed\0",
        since_minor: 1,
        stability: Stability::Stable,
        arity: Arity::Many,
        capability: None,
    },
    PointSpec {
        id: PointId::HostResolveAsset,
        symbol: b"carbon_ext_host_resolve_asset\0",
        since_minor: 1,
        stability: Stability::Experimental,
        arity: Arity::Exclusive,
        capability: Some("fs.read"),
    },
];

impl PointSpec {
    /// The exported symbol without its trailing NUL, for messages.
    pub fn symbol_str(&self) -> &'static str {
        match core::str::from_utf8(&self.symbol[..self.symbol.len() - 1]) {
            Ok(s) => s,
            Err(_) => "<non-utf8 symbol>",
        }
    }
}

// ── Signatures ─────────────────────────────────────────────────────────────
//
// One typedef per point, so the loader transmutes a resolved symbol into a
// type that came from the same registry the plugin compiled against rather
// than one written out by hand next to it.

/// `lifecycle.register` — Once, after the app bundle has been evaluated — so a
/// plugin's globals shadow the app's rather than the other way round.
pub type LifecycleRegisterFn = unsafe extern "C" fn(app: *mut CarbonApp);

/// `lifecycle.before_bundle_eval` — Immediately before each evaluation of the
/// app bundle — the first one at startup, and every HMR re-evaluation after it.
pub type LifecycleBeforeBundleEvalFn = unsafe extern "C" fn(app: *mut CarbonApp);

/// `lifecycle.before_reload` — Before HMR re-evaluates the JS bundle.
pub type LifecycleBeforeReloadFn = unsafe extern "C" fn(app: *mut CarbonApp);

/// `lifecycle.after_reload` — After the new JS bundle has finished evaluating.
pub type LifecycleAfterReloadFn = unsafe extern "C" fn(app: *mut CarbonApp);

/// `lifecycle.shutdown` — Once at exit, in REVERSE load order, before the
/// library is unloaded.
pub type LifecycleShutdownFn = unsafe extern "C" fn(app: *mut CarbonApp);

/// `paint.before` — Every frame, after the rasterizer has drawn the scene and
/// before the pixmap is presented.
pub type PaintBeforeFn = unsafe extern "C" fn(
    app: *mut CarbonApp,
    pixmap: *mut u8,
    width: u32,
    height: u32,
    stride_bytes: u32,
);

/// `paint.after` — Every frame, after present.
pub type PaintAfterFn = unsafe extern "C" fn(app: *mut CarbonApp);

/// `window.resized` — After the window resized and app->window_width/height
/// were updated.
pub type WindowResizedFn = unsafe extern "C" fn(app: *mut CarbonApp, width: u32, height: u32);

/// `window.theme_changed` — When the OS theme changes, alongside the JS
/// __cm_dispatch_theme_changed dispatch.
pub type WindowThemeChangedFn = unsafe extern "C" fn(app: *mut CarbonApp, is_dark: i32);

/// `host.resolve_asset` — NOT YET DISPATCHED — see the doc. Intended: when the
/// runtime cannot resolve an asset specifier itself, before it reports a load
/// failure.
pub type HostResolveAssetFn =
    unsafe extern "C" fn(app: *mut CarbonApp, request: *const c_char) -> i32;

/// Keeps `c_char` used when no point in the registry takes a string.
#[allow(dead_code)]
type _KeepCCharUsed = *const c_char;
