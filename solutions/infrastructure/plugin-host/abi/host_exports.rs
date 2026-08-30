// Some helpers below (e.g. set_raw_window_handles, unmark_current_thread_as_js)
// are only invoked by Agent 4's canvas-plugin migration; keep them callable
// without dead-code noise.
#![allow(dead_code)]

// host_exports — the runtime side of the Carbon plugin C ABI.
//
// This module provides:
//
//   1. The shared `CarbonApp` struct (mirroring `ecosystem/users/sdk/include/
//      carbon_plugin.h`) that we hand to plugins. We don't import the SDK's
//      `ffi::CarbonApp` directly to avoid a circular crate dep — but the
//      layout MUST match byte-for-byte. There's a static assertion below
//      that checks size_of::<HostCarbonApp>() == size_of::<sdk::CarbonApp>()
//      at the test layer.
//
//   2. The host's `host_push_event`, `host_request_paint`, `host_alloc`,
//      `host_free` function pointers — bolted onto the CarbonApp before
//      plugins see it. Safe to call from any thread.
//
//   3. The `#[no_mangle]` `carbon_js_*` extern "C" exports — these are
//      what the Rust SDK resolves via GetProcAddress(GetModuleHandle(NULL))
//      at plugin-load time. They reach into the rquickjs JSContext (which
//      is what we cast `*mut CarbonJSContext` to) and call the QuickJS C
//      API directly through `rquickjs::qjs::*`.
//
// THREADING: the JS context is single-threaded. Plugin code on a non-JS
// thread that calls `carbon_js_*` would race with the event loop. We
// install a `thread_local!` flag on the JS thread at startup; the
// `carbon_js_*` helpers check it and return CARBON_ERR_NO_CTX from any
// other thread. Plugins that need to talk to JS from a worker MUST
// instead push an event via `app->push_event(...)`, which routes through
// the EventLoopProxy and lands on the JS thread.

use carbon_runtime_contract::UserEvent;
use rquickjs::qjs;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Mutex;
use tao::event_loop::EventLoopProxy;

// ── ABI status codes (mirror carbon_plugin.h / SDK ffi.rs) ────────────────
pub const CARBON_OK: i32 = 0;
pub const CARBON_ERR_GENERIC: i32 = -1;
pub const CARBON_ERR_INVALID: i32 = -2;
pub const CARBON_ERR_QUEUE_FULL: i32 = -3;
pub const CARBON_ERR_NO_CTX: i32 = -4;

pub const CARBON_PLUGIN_ABI_VERSION_MAJOR: u32 = 1;
// 2, not 1: ABI 1.2 appended load_font_path/load_font_bytes to
// HostCarbonApp — see the note on those fields below and carbon_plugin.h's
// APPEND-ONLY ZONE. (1.1 appended set_global_string/set_global_number/
// set_global_function/eval before that.)
pub const CARBON_PLUGIN_ABI_VERSION_MINOR: u32 = 2;

// ── CarbonJSContext — opaque to plugins ───────────────────────────────────
//
// The plugin sees `*mut CarbonJSContext`. Internally we store the raw
// QuickJS `JSContext*` cast through this opaque type so we can cast back.
#[repr(C)]
pub struct CarbonJSContext {
    _private: [u8; 0],
}

// Type alias matching the SDK's `CarbonJSCallback` so plugins can pass the
// same fn pointer they declared in their own code. Declared here, ahead of
// `HostCarbonApp`, because `set_global_function` below is typed with it.
pub type CarbonJSCallback = unsafe extern "C" fn(
    ctx: *mut CarbonJSContext,
    args_json: *const c_char,
    result_buf: *mut c_char,
    result_buf_len: usize,
);

// ── HostCarbonApp — runtime-side mirror of `struct CarbonApp` ─────────────
//
// CRITICAL: layout MUST match `ecosystem/users/sdk/rust/src/ffi.rs` and
// `ecosystem/users/sdk/include/carbon_plugin.h`. Order, types, alignment.
// Append-only — never insert in the middle.
#[repr(C)]
pub struct HostCarbonApp {
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
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            event_name: *const c_char,
            json_payload: *const c_char,
        ) -> i32,
    >,
    pub request_paint: Option<unsafe extern "C" fn(app: *mut HostCarbonApp)>,
    pub alloc: Option<unsafe extern "C" fn(size: usize) -> *mut c_void>,
    pub free: Option<unsafe extern "C" fn(ptr: *mut c_void)>,
    // ── APPEND-ONLY ZONE — see header. New fields go below this line.

    // ABI 1.1. The carbon_js_* operations as struct fields rather than a
    // runtime GetProcAddress/dlsym lookup — see carbon_plugin.h's note on
    // these same four fields for why: the plugin trust checker
    // (solutions/capabilities/plugin/trust) denies GetProcAddress and
    // GetModuleHandle* from a compiled plugin's import table unconditionally,
    // because a plugin that can resolve one arbitrary symbol at runtime can
    // resolve any of them. These fields are how a plugin gets the one
    // resolution it actually needs (installing JS globals) without going
    // through that door — the same shape push_event and request_paint above
    // already use.
    pub set_global_string: Option<
        unsafe extern "C" fn(
            ctx: *mut CarbonJSContext,
            name: *const c_char,
            value: *const c_char,
        ) -> i32,
    >,
    pub set_global_number: Option<
        unsafe extern "C" fn(ctx: *mut CarbonJSContext, name: *const c_char, value: f64) -> i32,
    >,
    pub set_global_function: Option<
        unsafe extern "C" fn(
            ctx: *mut CarbonJSContext,
            name: *const c_char,
            cb: CarbonJSCallback,
        ) -> i32,
    >,
    pub eval: Option<unsafe extern "C" fn(ctx: *mut CarbonJSContext, source: *const c_char) -> i32>,

    // ABI 1.2. Load a font into the text engine, optionally under a family
    // name for later font-family-based selection — see the note on these
    // two fields in carbon_plugin.h for the full contract. Installed by
    // `install_text_engine`/`install_on_font_loaded` (called once from
    // mini.rs at startup, before any plugin loads).
    pub load_font_path: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            path: *const c_char,
            family_name: *const c_char,
            weight: u32,
        ) -> i32,
    >,
    pub load_font_bytes: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            bytes: *const u8,
            len: usize,
            family_name: *const c_char,
            weight: u32,
        ) -> i32,
    >,
}

/// Owns the heap allocation backing the strings inside `HostCarbonApp` plus
/// the `EventLoopProxy` that `host_push_event` reaches through. Built once
/// at startup and pinned for the runtime's lifetime — plugins keep raw
/// pointers into it, so it must NOT move or drop while any plugin is
/// loaded.
pub struct HostCarbonAppStorage {
    pub app: HostCarbonApp,
    // CStrings keeping app metadata strings alive. Never reassigned — the
    // pointers in `app` are baked from these. If a future feature needs to
    // mutate app metadata at runtime (rename + re-display), expose a
    // helper that swaps these atomically with a Mutex<CString>.
    _app_name: CString,
    _app_version: CString,
    _project_dir: CString,
}

// ── Event-loop proxy shared across all host_* trampolines ─────────────────
//
// `host_push_event` and `host_request_paint` are called from PLUGIN
// threads. They have no &CarbonApp wrapper — just a raw pointer. So they
// fish the proxy out of a process-wide static instead of threading it
// through every plugin call.
//
// We store it as `Option<...>` so the no-mangle host_js_* functions can
// fail gracefully if invoked before the runtime has fully initialized
// (e.g. during a static-init order race in the unlikely future where
// plugins are loaded BEFORE the event loop).
static PROXY: Mutex<Option<EventLoopProxy<UserEvent>>> = Mutex::new(None);

pub fn install_event_loop_proxy(proxy: EventLoopProxy<UserEvent>) {
    *PROXY.lock().unwrap_or_else(|e| e.into_inner()) = Some(proxy);
}

// ── Font loading (ABI 1.2) ─────────────────────────────────────────────────
//
// `load_font_path`/`load_font_bytes` run synchronously ON THE JS THREAD: a
// plugin's `set_global_function` callback (where a font-loading call
// originates — see the fonts plugin) is invoked by QuickJS from wherever
// `carbon_plugin_register` installed it, and that install only ever happens
// on the JS thread (mirroring `carbon_js_set_global_function`'s own
// `on_js_thread()` guard). That's what makes it safe to reach `TextEngine`
// here directly (an `Rc<RefCell<…>>`, not `Send` — thread_local, not a
// Mutex<…> like PROXY, is what a JS-thread-only value wants) and return a
// REAL success/failure rather than push_event's "accepted, ask later" shape.
//
// `Scene` invalidation (so a newly-loaded font's metrics actually get
// re-measured) is a plain closure instead of a second typed thread_local —
// this crate has no reason to depend on the `layout` capability crate just
// to know Scene's shape, when "mark it dirty and repaint" is the only thing
// ever needed here.
thread_local! {
    static TEXT_ENGINE: std::cell::RefCell<Option<std::rc::Rc<std::cell::RefCell<carbon_text_renderer::TextEngine>>>> =
        const { std::cell::RefCell::new(None) };
    static ON_FONT_LOADED: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Installs the TextEngine `load_font_*` reaches into. Called once from
/// mini.rs at startup, before any plugin loads (same ordering requirement as
/// `install_event_loop_proxy`).
pub fn install_text_engine(te: std::rc::Rc<std::cell::RefCell<carbon_text_renderer::TextEngine>>) {
    TEXT_ENGINE.with(|cell| *cell.borrow_mut() = Some(te));
}

/// Installs the callback run after a successful font load — mini.rs's copy
/// closes over the real `Scene` + `EventLoopProxy` to mark layout dirty and
/// request a repaint, without this crate needing to know either type.
pub fn install_on_font_loaded(cb: impl Fn() + 'static) {
    ON_FONT_LOADED.with(|cell| *cell.borrow_mut() = Some(Box::new(cb)));
}

fn notify_font_loaded() {
    ON_FONT_LOADED.with(|cell| {
        if let Some(f) = cell.borrow().as_ref() {
            f();
        }
    });
}

/// `weight == 0` means "unspecified" (the header says so) — TextEngine's
/// own `Option<u16>` default (400) applies. Otherwise clamp into the u16
/// range `load_font_bytes_named` expects (it clamps to 1-1000 itself).
fn weight_arg(weight: u32) -> Option<u16> {
    if weight == 0 {
        None
    } else {
        Some(weight.min(u16::MAX as u32) as u16)
    }
}

/// `app->load_font_path(path, family_name, weight)`.
unsafe extern "C" fn host_load_font_path(
    _app: *mut HostCarbonApp,
    path: *const c_char,
    family_name: *const c_char,
    weight: u32,
) -> i32 {
    if path.is_null() {
        return CARBON_ERR_INVALID;
    }
    if !on_js_thread() {
        return CARBON_ERR_NO_CTX;
    }
    let path = match CStr::from_ptr(path).to_str() {
        Ok(s) => s,
        Err(_) => return CARBON_ERR_INVALID,
    };
    let family = if family_name.is_null() {
        None
    } else {
        match CStr::from_ptr(family_name).to_str() {
            Ok(s) => Some(s.to_string()),
            Err(_) => return CARBON_ERR_INVALID,
        }
    };
    let ok = TEXT_ENGINE.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|te| {
                te.borrow_mut().load_font_path_named(
                    std::path::Path::new(path),
                    family,
                    weight_arg(weight),
                )
            })
            .unwrap_or(false)
    });
    if ok {
        notify_font_loaded();
        CARBON_OK
    } else {
        CARBON_ERR_GENERIC
    }
}

/// `app->load_font_bytes(bytes, len, family_name, weight)`.
unsafe extern "C" fn host_load_font_bytes(
    _app: *mut HostCarbonApp,
    bytes: *const u8,
    len: usize,
    family_name: *const c_char,
    weight: u32,
) -> i32 {
    if bytes.is_null() {
        return CARBON_ERR_INVALID;
    }
    if !on_js_thread() {
        return CARBON_ERR_NO_CTX;
    }
    let owned = std::slice::from_raw_parts(bytes, len).to_vec();
    let family = if family_name.is_null() {
        None
    } else {
        match CStr::from_ptr(family_name).to_str() {
            Ok(s) => Some(s.to_string()),
            Err(_) => return CARBON_ERR_INVALID,
        }
    };
    let ok = TEXT_ENGINE.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|te| te.borrow_mut().load_font_bytes_named(owned, family, weight_arg(weight)))
            .unwrap_or(false)
    });
    if ok {
        notify_font_loaded();
        CARBON_OK
    } else {
        CARBON_ERR_GENERIC
    }
}

// ── Trampolines stamped into HostCarbonApp ────────────────────────────────

/// `app->push_event(name, payload)` — pushes a UserEvent::PluginEvent
/// onto the tao event loop. Safe from any thread because EventLoopProxy
/// is `Send + Sync` and we serialize through a Mutex<Option<…>>.
unsafe extern "C" fn host_push_event(
    _app: *mut HostCarbonApp,
    event_name: *const c_char,
    json_payload: *const c_char,
) -> i32 {
    if event_name.is_null() {
        return CARBON_ERR_INVALID;
    }
    // Empty string is acceptable for "no payload" per the header contract.
    let name = match CStr::from_ptr(event_name).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return CARBON_ERR_INVALID,
    };
    let payload = if json_payload.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(json_payload).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return CARBON_ERR_INVALID,
        }
    };
    let proxy = PROXY.lock().unwrap_or_else(|e| e.into_inner());
    let proxy = match proxy.as_ref() {
        Some(p) => p,
        None => return CARBON_ERR_GENERIC,
    };
    match proxy.send_event(UserEvent::PluginEvent { name, payload }) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_QUEUE_FULL,
    }
}

unsafe extern "C" fn host_request_paint(_app: *mut HostCarbonApp) {
    let proxy = PROXY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = proxy.as_ref() {
        let _ = p.send_event(UserEvent::RequestPaint);
    }
}

// Cross-DLL allocator. Carbon-mini is Rust on both sides of the boundary,
// so std::alloc is fine — but we still funnel through here so plugins
// written in C / Zig don't have to depend on the host's stdlib.
//
// Format: 8 bytes of length prefix followed by the user payload, 8-byte
// aligned. The free() reads back the length to compute layout. (Without
// this, we'd lose the size at the FFI boundary and Rust's Layout-typed
// dealloc would be UB.)
unsafe extern "C" fn host_alloc(size: usize) -> *mut c_void {
    if size == 0 {
        return core::ptr::null_mut();
    }
    let total = size.saturating_add(16);
    let layout = match std::alloc::Layout::from_size_align(total, 16) {
        Ok(l) => l,
        Err(_) => return core::ptr::null_mut(),
    };
    let raw = std::alloc::alloc(layout);
    if raw.is_null() {
        return core::ptr::null_mut();
    }
    // Stash the user-requested size in the first 8 bytes so free() can
    // reconstruct the Layout.
    (raw as *mut usize).write(size);
    raw.add(16) as *mut c_void
}

unsafe extern "C" fn host_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let raw = (ptr as *mut u8).sub(16);
    let size = (raw as *mut usize).read();
    let total = size.saturating_add(16);
    if let Ok(layout) = std::alloc::Layout::from_size_align(total, 16) {
        std::alloc::dealloc(raw, layout);
    }
}

// ── Build the HostCarbonApp ───────────────────────────────────────────────

impl HostCarbonAppStorage {
    /// Allocate and initialize a HostCarbonApp. The returned value MUST be
    /// pinned somewhere (Box::leak / Pin<Box<…>>) for the runtime's
    /// lifetime — plugins hold `*mut HostCarbonApp` into it.
    pub fn new(
        app_name: &str,
        app_version: &str,
        project_dir: &str,
        window_width: u32,
        window_height: u32,
    ) -> Box<Self> {
        // Empty strings as fallback if the caller passed something invalid.
        let app_name_c = CString::new(app_name).unwrap_or_else(|_| CString::new("").unwrap());
        let app_version_c = CString::new(app_version).unwrap_or_else(|_| CString::new("").unwrap());
        let project_dir_c = CString::new(project_dir).unwrap_or_else(|_| CString::new("").unwrap());

        let mut storage = Box::new(HostCarbonAppStorage {
            app: HostCarbonApp {
                abi_version_major: CARBON_PLUGIN_ABI_VERSION_MAJOR,
                abi_version_minor: CARBON_PLUGIN_ABI_VERSION_MINOR,
                js_ctx: core::ptr::null_mut(),
                window_width,
                window_height,
                raw_window_handle: core::ptr::null_mut(),
                raw_display_handle: core::ptr::null_mut(),
                app_name: app_name_c.as_ptr(),
                app_version: app_version_c.as_ptr(),
                project_dir: project_dir_c.as_ptr(),
                window_id: 0,
                push_event: Some(host_push_event),
                request_paint: Some(host_request_paint),
                alloc: Some(host_alloc),
                free: Some(host_free),
                set_global_string: Some(carbon_js_set_global_string),
                set_global_number: Some(carbon_js_set_global_number),
                set_global_function: Some(carbon_js_set_global_function),
                eval: Some(carbon_js_eval),
                load_font_path: Some(host_load_font_path),
                load_font_bytes: Some(host_load_font_bytes),
            },
            _app_name: app_name_c,
            _app_version: app_version_c,
            _project_dir: project_dir_c,
        });
        // Re-bake the string pointers from the now-pinned CStrings (Box's
        // contents have a stable address; the field-init above used the
        // pre-move ptrs which would be invalidated when we boxed).
        storage.app.app_name = storage._app_name.as_ptr();
        storage.app.app_version = storage._app_version.as_ptr();
        storage.app.project_dir = storage._project_dir.as_ptr();
        storage
    }

    pub fn raw(&mut self) -> *mut HostCarbonApp {
        &mut self.app as *mut HostCarbonApp
    }

    /// Update the JS context pointer. Called once after rquickjs has
    /// finished its setup.
    pub fn set_js_context(&mut self, ctx: *mut CarbonJSContext) {
        self.app.js_ctx = ctx;
    }

    pub fn set_window_size(&mut self, w: u32, h: u32) {
        self.app.window_width = w;
        self.app.window_height = h;
    }

    pub fn set_raw_window_handles(&mut self, win: *mut c_void, display: *mut c_void) {
        self.app.raw_window_handle = win;
        self.app.raw_display_handle = display;
    }
}

// ── JS-thread guard ───────────────────────────────────────────────────────
//
// Set on the JS thread at startup; checked by every carbon_js_* helper.
// The QuickJS context is single-threaded — calling any JS_* function from
// another thread is undefined behavior (typically SIGSEGV). When the JS
// thread is being torn down (or hasn't started yet), the flag is unset
// and we return CARBON_ERR_NO_CTX.

thread_local! {
    static IS_JS_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn mark_current_thread_as_js() {
    IS_JS_THREAD.with(|c| c.set(true));
}

pub fn unmark_current_thread_as_js() {
    IS_JS_THREAD.with(|c| c.set(false));
}

#[inline]
fn on_js_thread() -> bool {
    IS_JS_THREAD.with(|c| c.get())
}

// ── #[no_mangle] carbon_js_* host exports ─────────────────────────────────
//
// The Rust SDK resolves these via GetProcAddress(GetModuleHandle(NULL)) on
// Windows (after the linker /EXPORT:s configured in build.rs publish them
// to the export table) and dlsym(RTLD_DEFAULT) on POSIX (which sees them
// because build.rs adds -rdynamic).

#[no_mangle]
pub unsafe extern "C" fn carbon_js_get_context(app: *mut HostCarbonApp) -> *mut CarbonJSContext {
    if app.is_null() {
        return core::ptr::null_mut();
    }
    if !on_js_thread() {
        return core::ptr::null_mut();
    }
    (*app).js_ctx
}

#[no_mangle]
pub unsafe extern "C" fn carbon_js_set_global_string(
    ctx: *mut CarbonJSContext,
    name: *const c_char,
    value: *const c_char,
) -> i32 {
    if ctx.is_null() || name.is_null() || value.is_null() {
        return CARBON_ERR_INVALID;
    }
    if !on_js_thread() {
        return CARBON_ERR_NO_CTX;
    }
    let raw_ctx = ctx as *mut qjs::JSContext;
    let value_cstr = CStr::from_ptr(value);
    let value_bytes = value_cstr.to_bytes();
    let js_value = qjs::JS_NewStringLen(raw_ctx, value_cstr.as_ptr(), value_bytes.len() as _);
    if qjs::JS_IsException(js_value) {
        return CARBON_ERR_GENERIC;
    }
    let global = qjs::JS_GetGlobalObject(raw_ctx);
    let r = qjs::JS_SetPropertyStr(raw_ctx, global, name, js_value);
    qjs::JS_FreeValue(raw_ctx, global);
    if r < 0 {
        CARBON_ERR_GENERIC
    } else {
        CARBON_OK
    }
}

#[no_mangle]
pub unsafe extern "C" fn carbon_js_set_global_number(
    ctx: *mut CarbonJSContext,
    name: *const c_char,
    value: f64,
) -> i32 {
    if ctx.is_null() || name.is_null() {
        return CARBON_ERR_INVALID;
    }
    if !on_js_thread() {
        return CARBON_ERR_NO_CTX;
    }
    let raw_ctx = ctx as *mut qjs::JSContext;
    let js_value = qjs::JS_NewFloat64(value);
    let global = qjs::JS_GetGlobalObject(raw_ctx);
    let r = qjs::JS_SetPropertyStr(raw_ctx, global, name, js_value);
    qjs::JS_FreeValue(raw_ctx, global);
    if r < 0 {
        CARBON_ERR_GENERIC
    } else {
        CARBON_OK
    }
}

// Bridge: QuickJS calls our generic JSCFunction wrapper, which:
//   1. Extracts the user's CarbonJSCallback from the function's "data" slot.
//   2. JSON-encodes the JS args.
//   3. Invokes the user callback with a stack buffer for the result.
//   4. Parses the result back into a JSValue.
//
// We use JS_NewCFunctionData so we can attach the user pointer (the actual
// CarbonJSCallback fn ptr) as the function's data. Without this we'd need a
// global registry keyed by name, which has thread-safety + hot-reload pain.
const CB_BUF_LEN: usize = 4096;

unsafe extern "C" fn carbon_callback_trampoline(
    ctx: *mut qjs::JSContext,
    _this_val: qjs::JSValue,
    argc: ::std::os::raw::c_int,
    argv: *mut qjs::JSValue,
    _magic: ::std::os::raw::c_int,
    func_data: *mut qjs::JSValue,
) -> qjs::JSValue {
    // Recover the user callback fn pointer from func_data[0].
    // We stuffed it as a 64-bit integer JSValue at registration time.
    let stored = func_data.add(0).read();
    // QuickJS represents integers as int32 internally; we need 64 bits for
    // a function pointer on x64. Workaround: stuff the pointer into a JS
    // ArrayBuffer or use a global registry. For now use a thread-local
    // registry keyed by an i32 cookie that QuickJS CAN store in func_data.
    let cookie = qjs::JS_VALUE_GET_INT(stored);
    let cb = match REGISTRY.with(|r| r.borrow().get(&cookie).copied()) {
        Some(c) => c,
        None => return qjs::JS_UNDEFINED,
    };

    // Build JSON args array.
    let mut args_arr = String::from("[");
    for i in 0..(argc as isize) {
        let v = argv.offset(i).read();
        let stringified = qjs::JS_JSONStringify(ctx, v, qjs::JS_UNDEFINED, qjs::JS_UNDEFINED);
        if !qjs::JS_IsException(stringified) && !qjs::JS_IsUndefined(stringified) {
            let mut len: qjs::size_t = 0;
            let cstr = qjs::JS_ToCStringLen2(ctx, &mut len as *mut _, stringified, false);
            if !cstr.is_null() {
                let s = std::slice::from_raw_parts(cstr as *const u8, len as usize);
                if i > 0 {
                    args_arr.push(',');
                }
                args_arr.push_str(std::str::from_utf8(s).unwrap_or("null"));
                qjs::JS_FreeCString(ctx, cstr);
            }
        } else {
            // Argument that didn't survive JSON.stringify (e.g. function).
            if i > 0 {
                args_arr.push(',');
            }
            args_arr.push_str("null");
        }
        qjs::JS_FreeValue(ctx, stringified);
    }
    args_arr.push(']');
    let args_c = match CString::new(args_arr) {
        Ok(s) => s,
        Err(_) => return qjs::JS_UNDEFINED,
    };

    let mut result_buf = [0u8; CB_BUF_LEN];
    cb(
        ctx as *mut CarbonJSContext,
        args_c.as_ptr(),
        result_buf.as_mut_ptr() as *mut c_char,
        CB_BUF_LEN,
    );
    // Result is expected to be a NUL-terminated JSON string (UTF-8). If
    // it's empty or invalid, treat as undefined.
    let result_cstr = match CStr::from_bytes_until_nul(&result_buf) {
        Ok(c) => c,
        Err(_) => return qjs::JS_UNDEFINED,
    };
    let bytes = result_cstr.to_bytes();
    if bytes.is_empty() {
        return qjs::JS_UNDEFINED;
    }
    qjs::JS_ParseJSON(
        ctx,
        result_cstr.as_ptr(),
        bytes.len() as _,
        b"<carbon-cb>\0".as_ptr() as _,
    )
}

thread_local! {
    static REGISTRY: std::cell::RefCell<std::collections::HashMap<i32, CarbonJSCallback>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static NEXT_COOKIE: std::cell::Cell<i32> = const { std::cell::Cell::new(1) };
}

#[no_mangle]
pub unsafe extern "C" fn carbon_js_set_global_function(
    ctx: *mut CarbonJSContext,
    name: *const c_char,
    cb: CarbonJSCallback,
) -> i32 {
    if ctx.is_null() || name.is_null() {
        return CARBON_ERR_INVALID;
    }
    if !on_js_thread() {
        return CARBON_ERR_NO_CTX;
    }
    let raw_ctx = ctx as *mut qjs::JSContext;
    let cookie = NEXT_COOKIE.with(|c| {
        let v = c.get();
        c.set(v.wrapping_add(1));
        v
    });
    REGISTRY.with(|r| r.borrow_mut().insert(cookie, cb));

    let mut data: [qjs::JSValue; 1] = [qjs::JS_MKVAL(qjs::JS_TAG_INT, cookie)];
    let func = qjs::JS_NewCFunctionData(
        raw_ctx,
        Some(carbon_callback_trampoline),
        0,
        0,
        1,
        data.as_mut_ptr(),
    );
    if qjs::JS_IsException(func) {
        REGISTRY.with(|r| r.borrow_mut().remove(&cookie));
        return CARBON_ERR_GENERIC;
    }
    let global = qjs::JS_GetGlobalObject(raw_ctx);
    let r = qjs::JS_SetPropertyStr(raw_ctx, global, name, func);
    qjs::JS_FreeValue(raw_ctx, global);
    if r < 0 {
        CARBON_ERR_GENERIC
    } else {
        CARBON_OK
    }
}

#[no_mangle]
pub unsafe extern "C" fn carbon_js_eval(ctx: *mut CarbonJSContext, source: *const c_char) -> i32 {
    if ctx.is_null() || source.is_null() {
        return CARBON_ERR_INVALID;
    }
    if !on_js_thread() {
        return CARBON_ERR_NO_CTX;
    }
    let raw_ctx = ctx as *mut qjs::JSContext;
    let src_cstr = CStr::from_ptr(source);
    let src_bytes = src_cstr.to_bytes();
    let filename = b"<carbon-plugin-eval>\0";
    let result = qjs::JS_Eval(
        raw_ctx,
        src_cstr.as_ptr(),
        src_bytes.len() as _,
        filename.as_ptr() as _,
        qjs::JS_EVAL_TYPE_GLOBAL as i32,
    );
    if qjs::JS_IsException(result) {
        // Drain the exception so it doesn't pollute the next eval.
        let exc = qjs::JS_GetException(raw_ctx);
        let cstr = qjs::JS_ToCString(raw_ctx, exc);
        if !cstr.is_null() {
            let s = CStr::from_ptr(cstr).to_string_lossy().into_owned();
            eprintln!("[carbon-plugin-eval] exception: {s}");
            qjs::JS_FreeCString(raw_ctx, cstr);
        }
        qjs::JS_FreeValue(raw_ctx, exc);
        return CARBON_ERR_GENERIC;
    }
    qjs::JS_FreeValue(raw_ctx, result);
    CARBON_OK
}

// ── Sanity: HostCarbonApp size/align should match the SDK's mirror ─────
//
// We can't depend on carbon-plugin-sdk from the runtime crate (it would
// pull in the panic-catching macros and confuse the symbol export setup),
// so this assertion lives in tests/plugin_loader_test.rs instead, which
// does pull in the SDK.
const _CARBON_APP_SIZE_NONZERO: () = assert!(core::mem::size_of::<HostCarbonApp>() > 0);
