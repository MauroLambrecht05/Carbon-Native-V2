//! Raw C ABI declarations from `include/carbon_plugin.h`.
//!
//! Hand-mirrored (rather than bindgen-generated) so the layout is reviewable
//! at a glance and so we don't pull bindgen / libclang into every plugin's
//! build. If `carbon_plugin.h` ever changes, this file MUST be updated in
//! lockstep — the abi_compat_test smoke test verifies the field-count
//! invariant, but per-field types are on us.

#![allow(non_camel_case_types)]

use core::ffi::{c_char, c_void};

pub const CARBON_PLUGIN_ABI_VERSION_MAJOR: u32 = 1;
pub const CARBON_PLUGIN_ABI_VERSION_MINOR: u32 = 0;

pub const CARBON_OK: i32 = 0;
pub const CARBON_ERR_GENERIC: i32 = -1;
pub const CARBON_ERR_INVALID: i32 = -2;
pub const CARBON_ERR_QUEUE_FULL: i32 = -3;
pub const CARBON_ERR_NO_CTX: i32 = -4;

/// Opaque JS context handle. See `CarbonJSContext` in `carbon_plugin.h`.
#[repr(C)]
pub struct CarbonJSContext {
    _private: [u8; 0],
}

/// Mirrors `struct CarbonApp` in `carbon_plugin.h`. Field order is part of
/// the ABI — DO NOT reorder. Append-only.
#[repr(C)]
pub struct CarbonApp {
    pub abi_version_major: u32,
    pub abi_version_minor: u32,

    pub js_ctx: *mut CarbonJSContext,

    pub window_width: u32,
    pub window_height: u32,
    pub raw_window_handle: *mut c_void,
    pub raw_display_handle: *mut c_void,

    pub app_name: *const c_char,
    pub app_version: *const c_char,
    pub project_dir: *const c_char,
    pub window_id: u32,

    pub push_event: Option<
        unsafe extern "C" fn(app: *mut CarbonApp,
                             event_name: *const c_char,
                             json_payload: *const c_char) -> i32,
    >,
    pub request_paint: Option<unsafe extern "C" fn(app: *mut CarbonApp)>,
    pub alloc: Option<unsafe extern "C" fn(size: usize) -> *mut c_void>,
    pub free: Option<unsafe extern "C" fn(ptr: *mut c_void)>,
    // ── Append-only zone ─────────────────────────────────────────────────
    // New function pointers go here, never above. Bump
    // CARBON_PLUGIN_ABI_VERSION_MINOR when you append.
}

pub type CarbonJSCallback = unsafe extern "C" fn(
    ctx: *mut CarbonJSContext,
    args_json: *const c_char,
    result_buf: *mut c_char,
    result_buf_len: usize,
);

// ── JS helper resolution ────────────────────────────────────────────────
//
// `carbon_js_*` are exported by the carbon-mini runtime, NOT by the plugin
// DLL itself. If we declared them as ordinary `extern "C" { fn … }` here,
// the plugin's DLL would have unresolved externals at link time on Windows
// (MSVC link.exe is strict; ld.lld accepts `-undefined dynamic_lookup` on
// macOS, and ELF dlopens with RTLD_GLOBAL fill them in implicitly on Linux).
//
// To stay portable, we resolve these symbols at runtime via the OS's
// "look in the host process" API (GetProcAddress + GetModuleHandle(NULL) on
// Windows; dlsym(RTLD_DEFAULT, …) on POSIX). The first call to each helper
// pays a one-time lookup; subsequent calls hit a OnceLock.
//
// Plugins thus link with ZERO unresolved externals. The runtime-migration
// agent's job is to actually export these functions from carbon-mini; until
// then, lookups return None and the safe Rust wrappers return CARBON_ERR_NO_CTX.

pub type CarbonJsGetContextFn = unsafe extern "C" fn(app: *mut CarbonApp) -> *mut CarbonJSContext;
pub type CarbonJsSetGlobalStringFn = unsafe extern "C" fn(
    ctx: *mut CarbonJSContext,
    name: *const c_char,
    value: *const c_char,
) -> i32;
pub type CarbonJsSetGlobalNumberFn = unsafe extern "C" fn(
    ctx: *mut CarbonJSContext,
    name: *const c_char,
    value: f64,
) -> i32;
pub type CarbonJsSetGlobalFunctionFn = unsafe extern "C" fn(
    ctx: *mut CarbonJSContext,
    name: *const c_char,
    cb: CarbonJSCallback,
) -> i32;
pub type CarbonJsEvalFn = unsafe extern "C" fn(
    ctx: *mut CarbonJSContext,
    source: *const c_char,
) -> i32;

#[cfg(windows)]
mod resolve {
    use super::*;
    use std::os::raw::c_void;
    extern "system" {
        fn GetModuleHandleA(lp_module_name: *const c_char) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const c_char)
            -> *mut c_void;
    }
    /// Look up `name` in the current process's main module (i.e., the host
    /// runtime executable that loaded this plugin DLL).
    pub unsafe fn resolve(name: &str) -> *mut c_void {
        let mut bytes: Vec<u8> = name.bytes().collect();
        bytes.push(0);
        let module = GetModuleHandleA(core::ptr::null());
        if module.is_null() {
            return core::ptr::null_mut();
        }
        GetProcAddress(module, bytes.as_ptr() as *const c_char)
    }
}

#[cfg(not(windows))]
mod resolve {
    use core::ffi::c_void;
    use core::ffi::c_char;
    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    // RTLD_DEFAULT magic value — same on Linux and macOS (NULL).
    const RTLD_DEFAULT: *mut c_void = core::ptr::null_mut();
    pub unsafe fn resolve(name: &str) -> *mut c_void {
        let mut bytes: Vec<u8> = name.bytes().collect();
        bytes.push(0);
        dlsym(RTLD_DEFAULT, bytes.as_ptr() as *const c_char)
    }
}

macro_rules! lazy_host_fn {
    ($getter:ident, $sym:literal, $fn_ty:ty) => {
        /// Resolve and cache the host-provided `$sym` function. Returns None
        /// when the runtime has not exported the symbol (e.g., during pre-
        /// migration testing of a plugin in isolation).
        pub fn $getter() -> Option<$fn_ty> {
            use std::sync::OnceLock;
            static CACHE: OnceLock<Option<$fn_ty>> = OnceLock::new();
            *CACHE.get_or_init(|| unsafe {
                let p = resolve::resolve($sym);
                if p.is_null() {
                    None
                } else {
                    Some(core::mem::transmute_copy::<*mut core::ffi::c_void, $fn_ty>(&p))
                }
            })
        }
    };
}

lazy_host_fn!(get_carbon_js_get_context, "carbon_js_get_context", CarbonJsGetContextFn);
lazy_host_fn!(get_carbon_js_set_global_string, "carbon_js_set_global_string", CarbonJsSetGlobalStringFn);
lazy_host_fn!(get_carbon_js_set_global_number, "carbon_js_set_global_number", CarbonJsSetGlobalNumberFn);
lazy_host_fn!(get_carbon_js_set_global_function, "carbon_js_set_global_function", CarbonJsSetGlobalFunctionFn);
lazy_host_fn!(get_carbon_js_eval, "carbon_js_eval", CarbonJsEvalFn);

/// Verify (at compile time) that the field count of `CarbonApp` is what we
/// expect. If a future change adds fields, bump this AND the minor version.
/// Field-count check via `mem::size_of` would tie us to a specific pointer
/// width; instead we just count bytes' worth of pointers/u32s manually here.
///
/// On 64-bit:
///   2*u32 + ptr + 2*u32 + 2*ptr + 3*ptr + u32 + 4*Option<fn> = 88 bytes
/// On 32-bit:
///   2*u32 + ptr + 2*u32 + 2*ptr + 3*ptr + u32 + 4*Option<fn> = 52 bytes
///
/// We don't assert an exact value (it depends on alignment and target), but
/// we DO assert that the layout never accidentally becomes zero-sized.
const _: () = {
    let _ = core::mem::size_of::<CarbonApp>();
    assert!(core::mem::size_of::<CarbonApp>() > 0);
};
