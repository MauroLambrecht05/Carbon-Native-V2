//! # carbon-plugin-sdk
//!
//! Safe Rust wrappers around the Carbon plugin C ABI defined in
//! `ecosystem/users/sdk/include/carbon_plugin.h`.
//!
//! Plugin authors implement their entry points using the SDK's helpers and
//! the `carbon_plugin!` macro, which generates the `extern "C"` trampolines
//! that carbon-mini calls into.
//!
//! ## Minimal example
//!
//! ```ignore
//! use carbon_plugin_sdk::{
//!     CarbonApp,
//!     capability::{Capability, Manifest},
//!     carbon_plugin,
//! };
//!
//! fn register(app: &mut CarbonApp) {
//!     app.set_global_string("hello_from_plugin", "world").ok();
//! }
//!
//! fn manifest() -> Manifest {
//!     Manifest::new("hello", "0.1.0")
//!         .require_capability(Capability::FsRead)
//!         .module("carbon:hello")
//!         .hook("register")
//! }
//!
//! carbon_plugin! {
//!     register: register,
//!     manifest: manifest,
//! }
//! ```
//!
//! After compiling as a `cdylib`, this produces a `.dll` / `.so` exporting:
//!   * `carbon_plugin_register`
//!   * `carbon_plugin_manifest`
//!
//! Optional lifecycle hooks (`before_reload`, `after_reload`, `before_paint`,
//! `after_paint`, `on_resize`, `on_shutdown`) can be added to the macro
//! invocation. They're omitted from the export list otherwise — carbon-mini
//! resolves them via dlsym so missing symbols are silently skipped.

#![deny(rust_2018_idioms)]

pub mod capability;
pub mod ffi;
pub mod push;

use core::ffi::c_char;
use std::ffi::{CStr, CString};

pub use capability::{Capability, Manifest};
pub use ffi::{
    CarbonJSContext, CARBON_ERR_GENERIC, CARBON_ERR_INVALID, CARBON_ERR_NO_CTX,
    CARBON_ERR_QUEUE_FULL, CARBON_OK, CARBON_PLUGIN_ABI_VERSION_MAJOR,
    CARBON_PLUGIN_ABI_VERSION_MINOR,
};
pub use push::{push_event_raw, try_push};

/// Safe view over a raw `*mut ffi::CarbonApp`. The pointer is borrowed for
/// the duration of the wrapping `CarbonApp` value — this struct never owns
/// the underlying memory and never frees it.
pub struct CarbonApp {
    raw: *mut ffi::CarbonApp,
}

impl CarbonApp {
    /// Construct a `CarbonApp` wrapper from the raw pointer carbon-mini
    /// passed to a plugin entry point.
    ///
    /// # Safety
    /// `raw` must be a non-null pointer to a `CarbonApp` instance owned by
    /// the runtime, valid for the duration of the call this wraps.
    pub unsafe fn from_raw(raw: *mut ffi::CarbonApp) -> Self {
        debug_assert!(!raw.is_null(), "carbon-mini handed us a null CarbonApp");
        Self { raw }
    }

    pub fn raw(&self) -> *mut ffi::CarbonApp {
        self.raw
    }

    pub fn abi_version(&self) -> (u32, u32) {
        // SAFETY: caller asserts raw is valid in `from_raw`.
        let app = unsafe { &*self.raw };
        (app.abi_version_major, app.abi_version_minor)
    }

    /// True if the runtime's ABI major version matches the SDK we were built
    /// against. Plugins should bail out of `register` if this returns false.
    pub fn abi_compatible(&self) -> bool {
        let (major, _) = self.abi_version();
        major == CARBON_PLUGIN_ABI_VERSION_MAJOR
    }

    pub fn window_size(&self) -> (u32, u32) {
        let app = unsafe { &*self.raw };
        (app.window_width, app.window_height)
    }

    pub fn raw_window_handle(&self) -> *mut core::ffi::c_void {
        unsafe { (*self.raw).raw_window_handle }
    }

    pub fn raw_display_handle(&self) -> *mut core::ffi::c_void {
        unsafe { (*self.raw).raw_display_handle }
    }

    pub fn app_name(&self) -> &str {
        cstr_or(unsafe { (*self.raw).app_name }, "")
    }

    pub fn app_version(&self) -> &str {
        cstr_or(unsafe { (*self.raw).app_version }, "")
    }

    pub fn project_dir(&self) -> &str {
        cstr_or(unsafe { (*self.raw).project_dir }, "")
    }

    pub fn window_id(&self) -> u32 {
        unsafe { (*self.raw).window_id }
    }

    /// Push an event from any thread to the JS-side handler.
    pub fn push_event(&self, name: &str, json_payload: &str) -> Result<(), i32> {
        try_push(self.raw, name, json_payload)
    }

    /// Schedule a redraw of the carbon-mini window.
    pub fn request_paint(&self) {
        let f = unsafe { (*self.raw).request_paint };
        if let Some(f) = f {
            unsafe { f(self.raw) }
        }
    }

    /// Get the JS context handle. Returns None if the runtime is shutting
    /// down or hasn't initialized the JS engine yet.
    pub fn js_context(&self) -> Option<*mut CarbonJSContext> {
        let p = unsafe { (*self.raw).js_ctx };
        if p.is_null() {
            None
        } else {
            Some(p)
        }
    }

    /// Convenience: install a string-valued global on `globalThis`.
    pub fn set_global_string(&self, name: &str, value: &str) -> Result<(), i32> {
        let ctx = self.js_context().ok_or(CARBON_ERR_NO_CTX)?;
        let f = ffi::get_carbon_js_set_global_string().ok_or(CARBON_ERR_NO_CTX)?;
        let cname = CString::new(name).map_err(|_| CARBON_ERR_INVALID)?;
        let cvalue = CString::new(value).map_err(|_| CARBON_ERR_INVALID)?;
        let r = unsafe { f(ctx, cname.as_ptr(), cvalue.as_ptr()) };
        if r == CARBON_OK { Ok(()) } else { Err(r) }
    }

    pub fn set_global_number(&self, name: &str, value: f64) -> Result<(), i32> {
        let ctx = self.js_context().ok_or(CARBON_ERR_NO_CTX)?;
        let f = ffi::get_carbon_js_set_global_number().ok_or(CARBON_ERR_NO_CTX)?;
        let cname = CString::new(name).map_err(|_| CARBON_ERR_INVALID)?;
        let r = unsafe { f(ctx, cname.as_ptr(), value) };
        if r == CARBON_OK { Ok(()) } else { Err(r) }
    }

    pub fn set_global_function(
        &self,
        name: &str,
        cb: ffi::CarbonJSCallback,
    ) -> Result<(), i32> {
        let ctx = self.js_context().ok_or(CARBON_ERR_NO_CTX)?;
        let f = ffi::get_carbon_js_set_global_function().ok_or(CARBON_ERR_NO_CTX)?;
        let cname = CString::new(name).map_err(|_| CARBON_ERR_INVALID)?;
        let r = unsafe { f(ctx, cname.as_ptr(), cb) };
        if r == CARBON_OK { Ok(()) } else { Err(r) }
    }

    /// Eval a JS source snippet. Prefer setting globals over this — eval is
    /// only exposed for bootstrap tricks.
    pub fn eval(&self, source: &str) -> Result<(), i32> {
        let ctx = self.js_context().ok_or(CARBON_ERR_NO_CTX)?;
        let f = ffi::get_carbon_js_eval().ok_or(CARBON_ERR_NO_CTX)?;
        let csrc = CString::new(source).map_err(|_| CARBON_ERR_INVALID)?;
        let r = unsafe { f(ctx, csrc.as_ptr()) };
        if r == CARBON_OK { Ok(()) } else { Err(r) }
    }
}

fn cstr_or<'a>(p: *const c_char, default: &'a str) -> &'a str {
    if p.is_null() {
        return default;
    }
    // SAFETY: caller asserts p is a NUL-terminated C string of static
    // lifetime relative to the call.
    unsafe { CStr::from_ptr(p) }.to_str().unwrap_or(default)
}

/// Generate the C ABI entry points for a Carbon plugin.
///
/// Required keys:
///   * `register: <fn(&mut CarbonApp)>`
///   * `manifest: <fn() -> Manifest>`
///
/// Optional keys (provide a function to wire each lifecycle hook):
///   * `before_reload`, `after_reload`
///   * `before_paint: fn(&mut CarbonApp, &mut [u8], u32, u32, u32)`
///   * `after_paint`
///   * `on_resize: fn(&mut CarbonApp, u32, u32)`
///   * `on_shutdown`
///
/// The macro:
///   1. Caches the manifest JSON in a `OnceLock<CString>` so the pointer
///      returned to carbon-mini is stable for the life of the DLL.
///   2. Catches panics at the FFI boundary so a panicking plugin can't
///      unwind across language boundaries (UB on Windows MSVC).
#[macro_export]
macro_rules! carbon_plugin {
    ($($tt:tt)*) => {
        $crate::__carbon_plugin_impl! { @parse [] $($tt)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_impl {
    // Done parsing — emit the FFI shims.
    (@parse [$($acc:tt)*]) => {
        $crate::__carbon_plugin_emit! { $($acc)* }
    };
    // Trailing comma terminator.
    (@parse [$($acc:tt)*] ,) => {
        $crate::__carbon_plugin_emit! { $($acc)* }
    };
    (@parse [$($acc:tt)*] $key:ident : $val:path , $($rest:tt)*) => {
        $crate::__carbon_plugin_impl! { @parse [$($acc)* ($key = $val)] $($rest)* }
    };
    (@parse [$($acc:tt)*] $key:ident : $val:path) => {
        $crate::__carbon_plugin_impl! { @parse [$($acc)* ($key = $val)] }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_emit {
    ($(($key:ident = $val:path))*) => {
        $crate::__carbon_plugin_pick_register! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_manifest! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_before_reload! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_after_reload! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_before_paint! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_after_paint! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_on_resize! { $(($key = $val))* }
        $crate::__carbon_plugin_pick_on_shutdown! { $(($key = $val))* }
    };
}

// The "pick" macros below select the user-supplied function for each hook
// (matching by literal identifier) and emit the matching extern "C" shim.
// If the user didn't supply that key, no shim is emitted — the symbol is
// absent from the DLL and carbon-mini's dlsym lookup returns null, which
// the runtime treats as "hook not implemented".

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_register {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_register! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_register {
    (@scan []) => { compile_error!("carbon_plugin! requires `register: <fn>`"); };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_register(app: *mut $crate::ffi::CarbonApp) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                if !wrapped.abi_compatible() {
                    eprintln!(
                        "[carbon-plugin-sdk] ABI major mismatch: plugin v{} runtime v{}",
                        $crate::CARBON_PLUGIN_ABI_VERSION_MAJOR,
                        wrapped.abi_version().0
                    );
                    return;
                }
                ($found)(&mut wrapped);
            });
        }
    };
    (@scan [$($acc:tt)*] (register = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_register! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_register! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_manifest {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_manifest! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_manifest {
    (@scan []) => { compile_error!("carbon_plugin! requires `manifest: <fn>`"); };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_manifest() -> *const ::core::ffi::c_char {
            use ::std::sync::OnceLock;
            static CACHED: OnceLock<::std::ffi::CString> = OnceLock::new();
            let s = CACHED.get_or_init(|| {
                let m: $crate::Manifest = ($found)();
                ::std::ffi::CString::new(m.to_json())
                    .unwrap_or_else(|_| ::std::ffi::CString::new("{}").unwrap())
            });
            s.as_ptr()
        }
    };
    (@scan [$($acc:tt)*] (manifest = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_manifest! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_manifest! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_before_reload {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_before_reload! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_before_reload {
    (@scan []) => { /* no hook */ };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_before_reload(app: *mut $crate::ffi::CarbonApp) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                ($found)(&mut wrapped);
            });
        }
    };
    (@scan [$($acc:tt)*] (before_reload = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_before_reload! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_before_reload! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_after_reload {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_after_reload! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_after_reload {
    (@scan []) => { };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_after_reload(app: *mut $crate::ffi::CarbonApp) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                ($found)(&mut wrapped);
            });
        }
    };
    (@scan [$($acc:tt)*] (after_reload = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_after_reload! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_after_reload! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_before_paint {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_before_paint! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_before_paint {
    (@scan []) => { };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_before_paint(
            app: *mut $crate::ffi::CarbonApp,
            pixmap_data: *mut u8,
            width: u32,
            height: u32,
            stride_bytes: u32,
        ) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() || pixmap_data.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                let len = (stride_bytes as usize).saturating_mul(height as usize);
                let pixmap = ::core::slice::from_raw_parts_mut(pixmap_data, len);
                ($found)(&mut wrapped, pixmap, width, height, stride_bytes);
            });
        }
    };
    (@scan [$($acc:tt)*] (before_paint = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_before_paint! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_before_paint! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_after_paint {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_after_paint! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_after_paint {
    (@scan []) => { };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_after_paint(app: *mut $crate::ffi::CarbonApp) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                ($found)(&mut wrapped);
            });
        }
    };
    (@scan [$($acc:tt)*] (after_paint = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_after_paint! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_after_paint! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_on_resize {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_on_resize! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_on_resize {
    (@scan []) => { };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_on_resize(
            app: *mut $crate::ffi::CarbonApp,
            new_width: u32,
            new_height: u32,
        ) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                ($found)(&mut wrapped, new_width, new_height);
            });
        }
    };
    (@scan [$($acc:tt)*] (on_resize = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_on_resize! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_on_resize! { @scan [$($acc)*] $($rest)* }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_pick_on_shutdown {
    ($(($k:ident = $v:path))* ) => {
        $crate::__carbon_plugin_find_on_shutdown! { @scan [] $(($k = $v))* }
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __carbon_plugin_find_on_shutdown {
    (@scan []) => { };
    (@scan [$found:path]) => {
        #[no_mangle]
        pub unsafe extern "C" fn carbon_plugin_on_shutdown(app: *mut $crate::ffi::CarbonApp) {
            let _ = ::std::panic::catch_unwind(|| {
                if app.is_null() { return; }
                let mut wrapped = $crate::CarbonApp::from_raw(app);
                ($found)(&mut wrapped);
            });
        }
    };
    (@scan [$($acc:tt)*] (on_shutdown = $v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_on_shutdown! { @scan [$v] $($rest)* }
    };
    (@scan [$($acc:tt)*] ($_other:ident = $_v:path) $($rest:tt)*) => {
        $crate::__carbon_plugin_find_on_shutdown! { @scan [$($acc)*] $($rest)* }
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_round_trip() {
        let m = Manifest::new("hello", "0.1.0")
            .require_capability(Capability::FsRead)
            .optional_capability(Capability::Network)
            .module("carbon:hello")
            .hook("register");
        let json = m.to_json();
        let parsed: Manifest = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed.name, "hello");
        assert_eq!(parsed.abi_version_major, CARBON_PLUGIN_ABI_VERSION_MAJOR);
        assert_eq!(parsed.capabilities.required, vec!["fs.read".to_string()]);
        assert_eq!(parsed.capabilities.optional, vec!["network".to_string()]);
        assert_eq!(parsed.modules, vec!["carbon:hello".to_string()]);
    }

    #[test]
    fn capability_strings_stable() {
        assert_eq!(Capability::FsRead.as_str(), "fs.read");
        assert_eq!(Capability::AudioOutput.as_str(), "audio.output");
        assert_eq!(Capability::Custom("com.example.thing").as_str(), "com.example.thing");
    }

    #[test]
    fn carbon_app_struct_is_non_zst() {
        assert!(core::mem::size_of::<ffi::CarbonApp>() > 0);
    }
}
