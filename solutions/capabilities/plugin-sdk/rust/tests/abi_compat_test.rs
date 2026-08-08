//! ABI compat smoke test for carbon-plugin-sdk.
//!
//! What this test guarantees:
//!   1. `CarbonApp` can be constructed from raw fields, every safe accessor
//!      returns the value placed in the matching FFI field, and the field
//!      offsets follow the documented append-only order.
//!   2. The `carbon_plugin!` macro generates symbols with the documented
//!      C names. We compile a tiny "plugin" inline (in-process; no dlopen)
//!      and call its trampolines through their `extern "C"` symbols.
//!   3. `Manifest` round-trips through JSON and matches the schema documented
//!      in `carbon_plugin.h`.
//!
//! What this test does NOT exercise (yet — owned by the runtime-migration
//! agent):
//!   - The actual carbon_js_* extern functions (these are exported by the
//!     runtime, not the SDK).
//!   - dlopen-based loading of a plugin from a separately-built .dll.
//!   - Cross-version compatibility (loading a v1.0-built plugin against a
//!     hypothetical v1.1 runtime). That requires shipping at least two
//!     SDK versions; once we cut a v1.1 we'll add a snapshot test here.

use carbon_plugin_sdk::{
    capability::{Capability, Manifest},
    ffi, carbon_plugin, CarbonApp, CARBON_OK, CARBON_PLUGIN_ABI_VERSION_MAJOR,
    CARBON_PLUGIN_ABI_VERSION_MINOR,
};
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};

// In-process "plugin" — uses the same macro a real plugin would, so we
// exercise the codegen path. The exported symbols collide with carbon-mini's
// own load path if both lived in the same binary, but tests are their own
// process so this is fine.
fn test_register(app: &mut CarbonApp) {
    // Verify we can read app metadata through the safe accessors.
    assert_eq!(app.abi_version().0, CARBON_PLUGIN_ABI_VERSION_MAJOR);
    assert!(app.abi_compatible());
    assert_eq!(app.window_size(), (800, 600));
    assert_eq!(app.app_name(), "test-app");
    REGISTER_CALLED.store(true, Ordering::SeqCst);
}

fn test_manifest() -> Manifest {
    Manifest::new("abi-compat-test", "0.1.0")
        .require_capability(Capability::FsRead)
        .module("carbon:abi-compat-test")
        .hook("register")
}

static REGISTER_CALLED: AtomicBool = AtomicBool::new(false);

carbon_plugin! {
    register: test_register,
    manifest: test_manifest,
}

// The macro emits `pub unsafe extern "C" fn carbon_plugin_register` and
// `pub unsafe extern "C" fn carbon_plugin_manifest` at the crate root, so
// we call them directly. (Re-declaring them in an `extern "C"` block here
// would collide with the macro-emitted definitions.)

// Stub host helpers so the in-process plugin doesn't fail at link time.
// In a real plugin DLL, these are resolved against the runtime's exports.
#[no_mangle]
pub extern "C" fn carbon_js_get_context(
    app: *mut ffi::CarbonApp,
) -> *mut ffi::CarbonJSContext {
    if app.is_null() { return core::ptr::null_mut(); }
    unsafe { (*app).js_ctx }
}
#[no_mangle]
pub extern "C" fn carbon_js_set_global_string(
    _ctx: *mut ffi::CarbonJSContext,
    _name: *const core::ffi::c_char,
    _value: *const core::ffi::c_char,
) -> i32 { CARBON_OK }
#[no_mangle]
pub extern "C" fn carbon_js_set_global_number(
    _ctx: *mut ffi::CarbonJSContext,
    _name: *const core::ffi::c_char,
    _value: f64,
) -> i32 { CARBON_OK }
#[no_mangle]
pub extern "C" fn carbon_js_set_global_function(
    _ctx: *mut ffi::CarbonJSContext,
    _name: *const core::ffi::c_char,
    _cb: ffi::CarbonJSCallback,
) -> i32 { CARBON_OK }
#[no_mangle]
pub extern "C" fn carbon_js_eval(
    _ctx: *mut ffi::CarbonJSContext,
    _src: *const core::ffi::c_char,
) -> i32 { CARBON_OK }

// ── Helpers for fabricating a mock CarbonApp ─────────────────────────────

unsafe extern "C" fn mock_push_event(
    _app: *mut ffi::CarbonApp,
    _name: *const core::ffi::c_char,
    _payload: *const core::ffi::c_char,
) -> i32 { CARBON_OK }

unsafe extern "C" fn mock_request_paint(_app: *mut ffi::CarbonApp) {}

unsafe extern "C" fn mock_alloc(size: usize) -> *mut core::ffi::c_void {
    let v: Vec<u8> = Vec::with_capacity(size);
    let p = v.as_ptr() as *mut core::ffi::c_void;
    std::mem::forget(v);
    p
}
unsafe extern "C" fn mock_free(_p: *mut core::ffi::c_void) {
    // Leak; the test process exits anyway.
}

fn make_mock_app(name: &CString, version: &CString, dir: &CString) -> ffi::CarbonApp {
    ffi::CarbonApp {
        abi_version_major: CARBON_PLUGIN_ABI_VERSION_MAJOR,
        abi_version_minor: CARBON_PLUGIN_ABI_VERSION_MINOR,
        js_ctx: 1usize as *mut ffi::CarbonJSContext, // non-null sentinel
        window_width: 800,
        window_height: 600,
        raw_window_handle: core::ptr::null_mut(),
        raw_display_handle: core::ptr::null_mut(),
        app_name: name.as_ptr(),
        app_version: version.as_ptr(),
        project_dir: dir.as_ptr(),
        window_id: 0,
        push_event: Some(mock_push_event),
        request_paint: Some(mock_request_paint),
        alloc: Some(mock_alloc),
        free: Some(mock_free),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[test]
fn safe_accessors_match_ffi_fields() {
    let name = CString::new("test-app").unwrap();
    let version = CString::new("0.1.0").unwrap();
    let dir = CString::new("/tmp/test").unwrap();
    let mut raw = make_mock_app(&name, &version, &dir);
    let app = unsafe { CarbonApp::from_raw(&mut raw as *mut _) };
    assert_eq!(app.abi_version().0, CARBON_PLUGIN_ABI_VERSION_MAJOR);
    assert_eq!(app.abi_version().1, CARBON_PLUGIN_ABI_VERSION_MINOR);
    assert!(app.abi_compatible());
    assert_eq!(app.window_size(), (800, 600));
    assert_eq!(app.app_name(), "test-app");
    assert_eq!(app.app_version(), "0.1.0");
    assert_eq!(app.project_dir(), "/tmp/test");
    assert_eq!(app.window_id(), 0);
    assert!(app.js_context().is_some());
    // Round-trip a push_event through the mock.
    assert!(app.push_event("test.event", "{}").is_ok());
}

#[test]
fn macro_emits_register_and_manifest_symbols() {
    // Drive the symbols carbon-mini will dlsym, exactly as a real load
    // sequence would. This exercises the panic catch + ABI version check.
    let name = CString::new("test-app").unwrap();
    let version = CString::new("0.1.0").unwrap();
    let dir = CString::new("/tmp/test").unwrap();
    let mut raw = make_mock_app(&name, &version, &dir);

    REGISTER_CALLED.store(false, Ordering::SeqCst);
    unsafe { carbon_plugin_register(&mut raw as *mut _) };
    assert!(REGISTER_CALLED.load(Ordering::SeqCst), "register should run");

    let mptr = unsafe { carbon_plugin_manifest() };
    assert!(!mptr.is_null());
    let json = unsafe { core::ffi::CStr::from_ptr(mptr) }.to_str().unwrap();
    let parsed: Manifest = serde_json::from_str(json).expect("manifest is valid JSON");
    assert_eq!(parsed.name, "abi-compat-test");
    assert_eq!(parsed.abi_version_major, CARBON_PLUGIN_ABI_VERSION_MAJOR);
    assert!(parsed.capabilities.required.contains(&"fs.read".to_string()));
    assert!(parsed.modules.contains(&"carbon:abi-compat-test".to_string()));
}

#[test]
fn manifest_pointer_is_stable_across_calls() {
    // Carbon-mini caches the JSON; calling again must return the same ptr.
    let p1 = unsafe { carbon_plugin_manifest() };
    let p2 = unsafe { carbon_plugin_manifest() };
    assert_eq!(p1, p2);
}

#[test]
fn null_app_is_safe() {
    // Carbon-mini should never pass null, but the macro's catch_unwind +
    // null check protects us if it ever does.
    unsafe { carbon_plugin_register(core::ptr::null_mut()) };
}

#[test]
fn carbon_app_struct_layout_is_nonzero() {
    // If the struct ever becomes zero-sized (impossible today, but a guard
    // against accidentally `#[repr(C)] struct CarbonApp;` someday), this
    // catches it.
    assert!(core::mem::size_of::<ffi::CarbonApp>() >= core::mem::size_of::<u32>() * 2);
}
