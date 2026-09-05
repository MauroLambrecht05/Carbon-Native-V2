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
// keychain_get only: no entry for (service, account) — a real, expected
// outcome, not a failure. See carbon_plugin.h's note on this constant.
pub const CARBON_NOT_FOUND: i32 = -5;

pub const CARBON_PLUGIN_ABI_VERSION_MAJOR: u32 = 1;
// 23, not 22: ABI 1.23 appended backend_name/runtime_features_json/
// snapshot_restored/manifest_read/framecache_stats/framecache_clear —
// Carbon self-introspection, not an OS/cloud capability. (1.22 appended
// camera_start/camera_stop; 1.21 appended
// microphone_start/microphone_stop; 1.20
// appended bluetooth_scan_start/bluetooth_scan_stop/
// bluetooth_connect/bluetooth_subscribe/bluetooth_write_characteristic;
// 1.19 appended share_content; 1.18 appended
// biometric_verify; 1.17 appended
// input_modifier_state/input_send_key/input_move_mouse/input_click_mouse/
// input_keyboard_layout; 1.16 appended media_get_volume/media_set_volume/media_get_mute/
// media_set_mute/media_listen_keys; 1.15 appended screen_capture; 1.14
// appended print_file; 1.13 appended accessibility_query; 1.12 appended
// log_write; 1.11 appended theme_query;
// 1.10 appended taskbar_set_progress/taskbar_set_badge; 1.9 appended
// sqlite_exec; 1.8 appended instance_acquire; 1.7 appended menu_setup;
// 1.6 appended deeplink_register; 1.5 appended tray_setup; 1.4 appended
// global_shortcut_register/unregister; 1.3 appended clipboard_*/dialog_*/
// notification_send/keychain_*; 1.2 appended load_font_path/
// load_font_bytes; 1.1 appended set_global_string/set_global_number/
// set_global_function/eval before that.)
pub const CARBON_PLUGIN_ABI_VERSION_MINOR: u32 = 23;

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

    // ABI 1.3. clipboard/dialog/notification/keychain — see the matching
    // note in carbon_plugin.h's APPEND-ONLY ZONE for the shared
    // string-return ownership contract (app->alloc'd, caller frees via
    // app->free; out_status distinguishes a real error from a legitimate
    // NULL like "cancelled" or "no clipboard content").
    pub clipboard_read_text:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char>,
    pub clipboard_write_text:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, text: *const c_char) -> i32>,
    pub clipboard_clear: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,

    pub dialog_open_file: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            opts_json: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,
    pub dialog_open_files: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            opts_json: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,
    pub dialog_open_dir: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            opts_json: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,
    pub dialog_save_file: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            opts_json: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,
    pub dialog_open_file_text: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            opts_json: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,
    pub dialog_save_file_text: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            opts_json: *const c_char,
            content: *const c_char,
        ) -> i32,
    >,
    pub dialog_message: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            title: *const c_char,
            body: *const c_char,
            level: *const c_char,
        ) -> i32,
    >,
    pub dialog_confirm: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            title: *const c_char,
            body: *const c_char,
        ) -> i32,
    >,

    pub notification_send: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            title: *const c_char,
            body: *const c_char,
            icon_path: *const c_char,
        ) -> i32,
    >,

    pub keychain_set: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            service: *const c_char,
            account: *const c_char,
            password: *const c_char,
        ) -> i32,
    >,
    pub keychain_get: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            service: *const c_char,
            account: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,
    pub keychain_delete: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            service: *const c_char,
            account: *const c_char,
        ) -> i32,
    >,

    // ABI 1.4. Global (OS-wide) keyboard shortcuts — see the matching note
    // in carbon_plugin.h's APPEND-ONLY ZONE.
    pub global_shortcut_register: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            accelerator: *const c_char,
            out_id: *mut u32,
        ) -> i32,
    >,
    pub global_shortcut_unregister:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, accelerator: *const c_char) -> i32>,

    // ABI 1.5. System tray — see the matching note in carbon_plugin.h's
    // APPEND-ONLY ZONE.
    pub tray_setup: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            icon_path: *const c_char,
            tooltip: *const c_char,
            menu_items_json: *const c_char,
        ) -> i32,
    >,

    // ABI 1.6. Deep linking — see the matching note in carbon_plugin.h's
    // APPEND-ONLY ZONE.
    pub deeplink_register:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, scheme: *const c_char) -> i32>,

    // ABI 1.7. Native application menu bar — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub menu_setup:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, menu_json: *const c_char) -> i32>,

    // ABI 1.8. Single-instance lock — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub instance_acquire:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, app_id: *const c_char) -> i32>,

    // ABI 1.9. Embedded SQLite storage — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub sqlite_exec: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            db_path: *const c_char,
            sql: *const c_char,
            params_json: *const c_char,
            out_status: *mut i32,
        ) -> *mut c_char,
    >,

    // ABI 1.10. Taskbar badge and progress — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub taskbar_set_progress:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, completed: u64, total: u64) -> i32>,
    pub taskbar_set_badge: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            icon_path: *const c_char,
            description: *const c_char,
        ) -> i32,
    >,

    // ABI 1.11. Theme preferences — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub theme_query:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char>,

    // ABI 1.12. Structured file logging — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub log_write: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            path: *const c_char,
            level: *const c_char,
            message: *const c_char,
        ) -> i32,
    >,

    // ABI 1.13. Screen-reader detection — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub accessibility_query:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_active: *mut i32) -> i32>,

    // ABI 1.14. Printing — see the matching note in carbon_plugin.h's
    // APPEND-ONLY ZONE.
    pub print_file: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, path: *const c_char) -> i32>,

    // ABI 1.15. Screen capture — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub screen_capture: Option<
        unsafe extern "C" fn(app: *mut HostCarbonApp, target: *const c_char, out_path: *const c_char) -> i32,
    >,

    // ABI 1.16. System audio volume/mute and media-key handling — see the
    // matching note in carbon_plugin.h's APPEND-ONLY ZONE.
    pub media_get_volume: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_level: *mut f32) -> i32>,
    pub media_set_volume: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, level: f32) -> i32>,
    pub media_get_mute: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_muted: *mut i32) -> i32>,
    pub media_set_mute: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, muted: i32) -> i32>,
    pub media_listen_keys: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,

    // ABI 1.17. Input — see the matching note in carbon_plugin.h's
    // APPEND-ONLY ZONE.
    pub input_modifier_state:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char>,
    pub input_send_key: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, vk: u16, key_down: i32) -> i32>,
    pub input_move_mouse: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, x: i32, y: i32) -> i32>,
    pub input_click_mouse:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, button: i32, is_down: i32) -> i32>,
    pub input_keyboard_layout:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char>,

    // ABI 1.18. Windows Hello biometric verification — see the matching
    // note in carbon_plugin.h's APPEND-ONLY ZONE.
    pub biometric_verify:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, message: *const c_char) -> i32>,

    // ABI 1.19. The native OS share sheet — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub share_content: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            title: *const c_char,
            text: *const c_char,
            url: *const c_char,
        ) -> i32,
    >,

    // ABI 1.20. BLE scan/connect/notify-subscribe/write — see the matching
    // note in carbon_plugin.h's APPEND-ONLY ZONE.
    pub bluetooth_scan_start: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,
    pub bluetooth_scan_stop: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,
    pub bluetooth_connect: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, address: *const c_char) -> i32>,
    pub bluetooth_subscribe: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            address: *const c_char,
            service_uuid: *const c_char,
            characteristic_uuid: *const c_char,
        ) -> i32,
    >,
    pub bluetooth_write_characteristic: Option<
        unsafe extern "C" fn(
            app: *mut HostCarbonApp,
            address: *const c_char,
            service_uuid: *const c_char,
            characteristic_uuid: *const c_char,
            data: *const u8,
            data_len: usize,
        ) -> i32,
    >,

    // ABI 1.21. Microphone PCM capture — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub microphone_start: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,
    pub microphone_stop: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,

    // ABI 1.22. Camera frame capture — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE.
    pub camera_start: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,
    pub camera_stop: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,

    // ABI 1.23. Carbon self-introspection — see the matching note in
    // carbon_plugin.h's APPEND-ONLY ZONE. The first three are plain data
    // (composed once at startup by the composition root, static for the
    // process lifetime), not trampolines — same reasoning app_name/
    // app_version/project_dir above are plain fields.
    pub backend_name: *const c_char,
    pub runtime_features_json: *const c_char,
    pub snapshot_restored: i32,
    pub manifest_read: Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char>,
    pub framecache_stats:
        Option<unsafe extern "C" fn(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char>,
    pub framecache_clear: Option<unsafe extern "C" fn(app: *mut HostCarbonApp) -> i32>,
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
    _backend_name: CString,
    _runtime_features_json: CString,
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

/// Push a plugin event from ANY thread, bypassing the C-ABI entirely —
/// for native code elsewhere in this crate (e.g. global_shortcuts.rs's
/// background listener thread) that wants the exact same delivery
/// `host_push_event` gives a plugin, without needing a `HostCarbonApp`
/// pointer or C-string marshaling to call it. `host_push_event` itself
/// delegates here after doing that marshaling.
pub fn push_plugin_event(name: String, payload: String) {
    let proxy = PROXY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = proxy.as_ref() {
        let _ = p.send_event(UserEvent::PluginEvent { name, payload });
    }
}

/// Same as `push_plugin_event`, but for a raw byte buffer instead of a
/// JSON string — camera frames, audio PCM, BLE notification bytes.
/// Rust-internal only, no C-ABI trampoline: every capability that needs
/// this (camera.rs, microphone.rs, bluetooth.rs) already lives in this
/// crate as a native adapter called from a Zig plugin's ABI trampoline
/// the normal way, exactly like media.rs calls `push_plugin_event`
/// directly today — there's no plugin author writing raw Rust here that
/// would need a C-ABI-exposed version of this, so one isn't added.
pub fn push_plugin_binary_event(name: String, data: Vec<u8>) {
    let proxy = PROXY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = proxy.as_ref() {
        let _ = p.send_event(UserEvent::PluginBinaryEvent { name, data });
    }
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
            .map(|te| {
                te.borrow_mut()
                    .load_font_bytes_named(owned, family, weight_arg(weight))
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

// ── clipboard / dialog / notification / keychain (ABI 1.3) ────────────────
//
// Thin C-ABI trampolines over solutions/infrastructure/plugin-host's own
// native/{clipboard,dialog,notification,keychain}.rs — plain Rust functions
// carrying the actual arboard/rfd/notify-rust/keyring calls. No thread
// affinity requirement here (unlike TEXT_ENGINE, nothing thread_local is
// touched): in practice every call still arrives on the JS thread, because
// the only caller path today is a plugin's `set_global_function` callback,
// which QuickJS only ever invokes synchronously from JS.

unsafe fn cstr_arg<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        None
    } else {
        CStr::from_ptr(ptr).to_str().ok()
    }
}

unsafe fn write_status(out_status: *mut i32, status: i32) {
    if !out_status.is_null() {
        *out_status = status;
    }
}

/// Allocate a NUL-terminated copy of `s` via `host_alloc` — the plugin
/// receiving the pointer owns it and must free it via `app->free`.
unsafe fn alloc_cstring(s: &str) -> *mut c_char {
    let bytes = s.as_bytes();
    let ptr = host_alloc(bytes.len() + 1) as *mut u8;
    if ptr.is_null() {
        return core::ptr::null_mut();
    }
    core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    *ptr.add(bytes.len()) = 0;
    ptr as *mut c_char
}

#[cfg(feature = "clipboard")]
unsafe extern "C" fn host_clipboard_read_text(
    _app: *mut HostCarbonApp,
    out_status: *mut i32,
) -> *mut c_char {
    match crate::clipboard::read_text() {
        Ok(s) if s.is_empty() => {
            write_status(out_status, CARBON_OK);
            core::ptr::null_mut()
        }
        Ok(s) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&s)
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

#[cfg(feature = "clipboard")]
unsafe extern "C" fn host_clipboard_write_text(
    _app: *mut HostCarbonApp,
    text: *const c_char,
) -> i32 {
    let Some(text) = cstr_arg(text) else {
        return CARBON_ERR_INVALID;
    };
    match crate::clipboard::write_text(text) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "clipboard")]
unsafe extern "C" fn host_clipboard_clear(_app: *mut HostCarbonApp) -> i32 {
    crate::clipboard::clear();
    CARBON_OK
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_open_file(
    _app: *mut HostCarbonApp,
    opts_json: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let Some(opts) = cstr_arg(opts_json) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    write_status(out_status, CARBON_OK);
    match crate::dialog::open_file(opts) {
        Some(p) => alloc_cstring(&p),
        None => core::ptr::null_mut(),
    }
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_open_files(
    _app: *mut HostCarbonApp,
    opts_json: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let Some(opts) = cstr_arg(opts_json) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    write_status(out_status, CARBON_OK);
    let paths = crate::dialog::open_files(opts);
    let json = serde_json::to_string(&paths).unwrap_or_else(|_| "[]".to_string());
    alloc_cstring(&json)
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_open_dir(
    _app: *mut HostCarbonApp,
    opts_json: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let Some(opts) = cstr_arg(opts_json) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    write_status(out_status, CARBON_OK);
    match crate::dialog::open_dir(opts) {
        Some(p) => alloc_cstring(&p),
        None => core::ptr::null_mut(),
    }
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_save_file(
    _app: *mut HostCarbonApp,
    opts_json: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let Some(opts) = cstr_arg(opts_json) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    write_status(out_status, CARBON_OK);
    match crate::dialog::save_file(opts) {
        Some(p) => alloc_cstring(&p),
        None => core::ptr::null_mut(),
    }
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_open_file_text(
    _app: *mut HostCarbonApp,
    opts_json: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let Some(opts) = cstr_arg(opts_json) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    match crate::dialog::open_file_text(opts) {
        Ok(Some(content)) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&content)
        }
        Ok(None) => {
            write_status(out_status, CARBON_OK);
            core::ptr::null_mut()
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_save_file_text(
    _app: *mut HostCarbonApp,
    opts_json: *const c_char,
    content: *const c_char,
) -> i32 {
    let (Some(opts), Some(content)) = (cstr_arg(opts_json), cstr_arg(content)) else {
        return CARBON_ERR_INVALID;
    };
    match crate::dialog::save_file_text(opts, content) {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_message(
    _app: *mut HostCarbonApp,
    title: *const c_char,
    body: *const c_char,
    level: *const c_char,
) -> i32 {
    let (Some(title), Some(body), Some(level)) = (cstr_arg(title), cstr_arg(body), cstr_arg(level))
    else {
        return CARBON_ERR_INVALID;
    };
    crate::dialog::message(title, body, level);
    CARBON_OK
}

#[cfg(feature = "dialog")]
unsafe extern "C" fn host_dialog_confirm(
    _app: *mut HostCarbonApp,
    title: *const c_char,
    body: *const c_char,
) -> i32 {
    let (Some(title), Some(body)) = (cstr_arg(title), cstr_arg(body)) else {
        return CARBON_ERR_INVALID;
    };
    if crate::dialog::confirm(title, body) {
        1
    } else {
        0
    }
}

#[cfg(feature = "notify")]
unsafe extern "C" fn host_notification_send(
    _app: *mut HostCarbonApp,
    title: *const c_char,
    body: *const c_char,
    icon_path: *const c_char,
) -> i32 {
    let (Some(title), Some(body)) = (cstr_arg(title), cstr_arg(body)) else {
        return CARBON_ERR_INVALID;
    };
    let icon = cstr_arg(icon_path).unwrap_or("");
    match crate::notification::send(title, body, icon) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "keychain")]
unsafe extern "C" fn host_keychain_set(
    _app: *mut HostCarbonApp,
    service: *const c_char,
    account: *const c_char,
    password: *const c_char,
) -> i32 {
    let (Some(service), Some(account), Some(password)) =
        (cstr_arg(service), cstr_arg(account), cstr_arg(password))
    else {
        return CARBON_ERR_INVALID;
    };
    match crate::keychain::set(service, account, password) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "keychain")]
unsafe extern "C" fn host_keychain_get(
    _app: *mut HostCarbonApp,
    service: *const c_char,
    account: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let (Some(service), Some(account)) = (cstr_arg(service), cstr_arg(account)) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    match crate::keychain::get(service, account) {
        Ok(Some(s)) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&s)
        }
        Ok(None) => {
            write_status(out_status, CARBON_NOT_FOUND);
            core::ptr::null_mut()
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

#[cfg(feature = "keychain")]
unsafe extern "C" fn host_keychain_delete(
    _app: *mut HostCarbonApp,
    service: *const c_char,
    account: *const c_char,
) -> i32 {
    let (Some(service), Some(account)) = (cstr_arg(service), cstr_arg(account)) else {
        return CARBON_ERR_INVALID;
    };
    match crate::keychain::delete(service, account) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Global keyboard shortcuts (ABI 1.4) ────────────────────────────────────

#[cfg(feature = "shortcuts")]
unsafe extern "C" fn host_global_shortcut_register(
    _app: *mut HostCarbonApp,
    accelerator: *const c_char,
    out_id: *mut u32,
) -> i32 {
    let Some(accelerator) = cstr_arg(accelerator) else {
        return CARBON_ERR_INVALID;
    };
    match crate::global_shortcuts::register(accelerator) {
        Ok(id) => {
            if !out_id.is_null() {
                *out_id = id;
            }
            CARBON_OK
        }
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "shortcuts")]
unsafe extern "C" fn host_global_shortcut_unregister(
    _app: *mut HostCarbonApp,
    accelerator: *const c_char,
) -> i32 {
    let Some(accelerator) = cstr_arg(accelerator) else {
        return CARBON_ERR_INVALID;
    };
    match crate::global_shortcuts::unregister(accelerator) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── System tray (ABI 1.5) ──────────────────────────────────────────────────

#[cfg(feature = "tray")]
unsafe extern "C" fn host_tray_setup(
    _app: *mut HostCarbonApp,
    icon_path: *const c_char,
    tooltip: *const c_char,
    menu_items_json: *const c_char,
) -> i32 {
    let Some(icon_path) = cstr_arg(icon_path) else {
        return CARBON_ERR_INVALID;
    };
    let tooltip = cstr_arg(tooltip).unwrap_or("");
    let menu_items_json = cstr_arg(menu_items_json).unwrap_or("");
    match crate::tray::setup(icon_path, tooltip, menu_items_json) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Deep linking (ABI 1.6) ──────────────────────────────────────────────

#[cfg(feature = "deeplink")]
unsafe extern "C" fn host_deeplink_register(app: *mut HostCarbonApp, scheme: *const c_char) -> i32 {
    let Some(scheme) = cstr_arg(scheme) else {
        return CARBON_ERR_INVALID;
    };
    let app_name = if app.is_null() {
        ""
    } else {
        cstr_arg((*app).app_name).unwrap_or("")
    };
    match crate::deeplink::register(app_name, scheme) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Native application menu bar (ABI 1.7) ──────────────────────────────────

#[cfg(feature = "menu")]
unsafe extern "C" fn host_menu_setup(app: *mut HostCarbonApp, menu_json: *const c_char) -> i32 {
    let Some(menu_json) = cstr_arg(menu_json) else {
        return CARBON_ERR_INVALID;
    };
    if app.is_null() {
        return CARBON_ERR_INVALID;
    }
    let hwnd = (*app).raw_window_handle as isize;
    match crate::menu::setup(hwnd, menu_json) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Single-instance lock (ABI 1.8) ──────────────────────────────────────────

#[cfg(feature = "instance")]
unsafe extern "C" fn host_instance_acquire(_app: *mut HostCarbonApp, app_id: *const c_char) -> i32 {
    let Some(app_id) = cstr_arg(app_id) else {
        return CARBON_ERR_INVALID;
    };
    match crate::instance::acquire(app_id) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Embedded SQLite storage (ABI 1.9) ───────────────────────────────────────

#[cfg(feature = "sqlite")]
unsafe extern "C" fn host_sqlite_exec(
    _app: *mut HostCarbonApp,
    db_path: *const c_char,
    sql: *const c_char,
    params_json: *const c_char,
    out_status: *mut i32,
) -> *mut c_char {
    let (Some(db_path), Some(sql)) = (cstr_arg(db_path), cstr_arg(sql)) else {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    };
    let params_json = cstr_arg(params_json).unwrap_or("");
    match crate::sqlite::exec(db_path, sql, params_json) {
        Ok(json) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&json)
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

// ── Taskbar badge and progress (ABI 1.10) ───────────────────────────────────

#[cfg(feature = "taskbar")]
unsafe extern "C" fn host_taskbar_set_progress(
    app: *mut HostCarbonApp,
    completed: u64,
    total: u64,
) -> i32 {
    if app.is_null() {
        return CARBON_ERR_INVALID;
    }
    let hwnd = (*app).raw_window_handle as isize;
    match crate::taskbar::set_progress(hwnd, completed, total) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "taskbar")]
unsafe extern "C" fn host_taskbar_set_badge(
    app: *mut HostCarbonApp,
    icon_path: *const c_char,
    description: *const c_char,
) -> i32 {
    if app.is_null() {
        return CARBON_ERR_INVALID;
    }
    let hwnd = (*app).raw_window_handle as isize;
    let icon_path = cstr_arg(icon_path).unwrap_or("");
    let description = cstr_arg(description).unwrap_or("");
    match crate::taskbar::set_badge(hwnd, icon_path, description) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Theme preferences (ABI 1.11) ────────────────────────────────────────────

#[cfg(feature = "theme")]
unsafe extern "C" fn host_theme_query(_app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char {
    match crate::theme::query() {
        Ok(prefs) => match serde_json::to_string(&prefs) {
            Ok(json) => {
                write_status(out_status, CARBON_OK);
                alloc_cstring(&json)
            }
            Err(_) => {
                write_status(out_status, CARBON_ERR_GENERIC);
                core::ptr::null_mut()
            }
        },
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

// ── Structured file logging (ABI 1.12) ──────────────────────────────────────

#[cfg(feature = "logging")]
unsafe extern "C" fn host_log_write(
    _app: *mut HostCarbonApp,
    path: *const c_char,
    level: *const c_char,
    message: *const c_char,
) -> i32 {
    let (Some(path), Some(level), Some(message)) = (cstr_arg(path), cstr_arg(level), cstr_arg(message)) else {
        return CARBON_ERR_INVALID;
    };
    match crate::logging::write_line(path, level, message) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Screen-reader detection (ABI 1.13) ──────────────────────────────────────

#[cfg(feature = "accessibility")]
unsafe extern "C" fn host_accessibility_query(_app: *mut HostCarbonApp, out_active: *mut i32) -> i32 {
    if out_active.is_null() {
        return CARBON_ERR_INVALID;
    }
    match crate::accessibility::screen_reader_active() {
        Ok(active) => {
            *out_active = if active { 1 } else { 0 };
            CARBON_OK
        }
        Err(_) => {
            *out_active = 0;
            CARBON_ERR_GENERIC
        }
    }
}

// ── Printing (ABI 1.14) ─────────────────────────────────────────────────────

#[cfg(feature = "printing")]
unsafe extern "C" fn host_print_file(_app: *mut HostCarbonApp, path: *const c_char) -> i32 {
    let Some(path) = cstr_arg(path) else {
        return CARBON_ERR_INVALID;
    };
    match crate::printing::print_file(path) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Screen capture (ABI 1.15) ────────────────────────────────────────────────

#[cfg(feature = "screencapture")]
unsafe extern "C" fn host_screen_capture(
    app: *mut HostCarbonApp,
    target: *const c_char,
    out_path: *const c_char,
) -> i32 {
    let (Some(target), Some(out_path)) = (cstr_arg(target), cstr_arg(out_path)) else {
        return CARBON_ERR_INVALID;
    };
    let hwnd = if app.is_null() { 0 } else { (*app).raw_window_handle as isize };
    match crate::screencapture::capture(target, hwnd, out_path) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── System audio volume/mute and media keys (ABI 1.16) ─────────────────────

#[cfg(feature = "media")]
unsafe extern "C" fn host_media_get_volume(_app: *mut HostCarbonApp, out_level: *mut f32) -> i32 {
    if out_level.is_null() {
        return CARBON_ERR_INVALID;
    }
    match crate::media::get_volume() {
        Ok(level) => {
            *out_level = level;
            CARBON_OK
        }
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "media")]
unsafe extern "C" fn host_media_set_volume(_app: *mut HostCarbonApp, level: f32) -> i32 {
    match crate::media::set_volume(level) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "media")]
unsafe extern "C" fn host_media_get_mute(_app: *mut HostCarbonApp, out_muted: *mut i32) -> i32 {
    if out_muted.is_null() {
        return CARBON_ERR_INVALID;
    }
    match crate::media::get_mute() {
        Ok(muted) => {
            *out_muted = if muted { 1 } else { 0 };
            CARBON_OK
        }
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "media")]
unsafe extern "C" fn host_media_set_mute(_app: *mut HostCarbonApp, muted: i32) -> i32 {
    match crate::media::set_mute(muted != 0) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "media")]
unsafe extern "C" fn host_media_listen_keys(_app: *mut HostCarbonApp) -> i32 {
    crate::media::ensure_media_key_listener();
    CARBON_OK
}

// ── Input (ABI 1.17) ─────────────────────────────────────────────────────────

#[cfg(feature = "input")]
unsafe extern "C" fn host_input_modifier_state(_app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char {
    let s = crate::input::modifier_state();
    let json = format!(
        "{{\"shift\":{},\"ctrl\":{},\"alt\":{},\"capsLock\":{},\"numLock\":{}}}",
        s.shift, s.ctrl, s.alt, s.caps_lock, s.num_lock
    );
    write_status(out_status, CARBON_OK);
    alloc_cstring(&json)
}

#[cfg(feature = "input")]
unsafe extern "C" fn host_input_send_key(_app: *mut HostCarbonApp, vk: u16, key_down: i32) -> i32 {
    match crate::input::send_key(vk, key_down != 0) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "input")]
unsafe extern "C" fn host_input_move_mouse(_app: *mut HostCarbonApp, x: i32, y: i32) -> i32 {
    match crate::input::move_mouse(x, y) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "input")]
unsafe extern "C" fn host_input_click_mouse(_app: *mut HostCarbonApp, button: i32, is_down: i32) -> i32 {
    match crate::input::click_mouse(button, is_down != 0) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "input")]
unsafe extern "C" fn host_input_keyboard_layout(_app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char {
    match crate::input::keyboard_layout_name() {
        Ok(name) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&format!("\"{name}\""))
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

// ── Biometrics (ABI 1.18) ────────────────────────────────────────────────────

#[cfg(feature = "biometrics")]
unsafe extern "C" fn host_biometric_verify(_app: *mut HostCarbonApp, message: *const c_char) -> i32 {
    let message = cstr_arg(message).unwrap_or("").to_string();
    match crate::biometrics::verify(message) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Sharing (ABI 1.19) ────────────────────────────────────────────────────

#[cfg(feature = "sharing")]
unsafe extern "C" fn host_share_content(
    app: *mut HostCarbonApp,
    title: *const c_char,
    text: *const c_char,
    url: *const c_char,
) -> i32 {
    if app.is_null() {
        return CARBON_ERR_INVALID;
    }
    let hwnd = (*app).raw_window_handle as isize;
    let title = cstr_arg(title).unwrap_or("");
    let text = cstr_arg(text).unwrap_or("");
    let url = cstr_arg(url).unwrap_or("");
    match crate::sharing::share(hwnd, title, text, url) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Bluetooth (ABI 1.20) ─────────────────────────────────────────────────

#[cfg(feature = "bluetooth")]
unsafe extern "C" fn host_bluetooth_scan_start(_app: *mut HostCarbonApp) -> i32 {
    match crate::bluetooth::scan_start() {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "bluetooth")]
unsafe extern "C" fn host_bluetooth_scan_stop(_app: *mut HostCarbonApp) -> i32 {
    match crate::bluetooth::scan_stop() {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "bluetooth")]
unsafe extern "C" fn host_bluetooth_connect(_app: *mut HostCarbonApp, address: *const c_char) -> i32 {
    let Some(address) = cstr_arg(address) else {
        return CARBON_ERR_INVALID;
    };
    match crate::bluetooth::connect(address) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "bluetooth")]
unsafe extern "C" fn host_bluetooth_subscribe(
    _app: *mut HostCarbonApp,
    address: *const c_char,
    service_uuid: *const c_char,
    characteristic_uuid: *const c_char,
) -> i32 {
    let (Some(address), Some(service_uuid), Some(characteristic_uuid)) =
        (cstr_arg(address), cstr_arg(service_uuid), cstr_arg(characteristic_uuid))
    else {
        return CARBON_ERR_INVALID;
    };
    match crate::bluetooth::subscribe(address, service_uuid, characteristic_uuid) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "bluetooth")]
unsafe extern "C" fn host_bluetooth_write_characteristic(
    _app: *mut HostCarbonApp,
    address: *const c_char,
    service_uuid: *const c_char,
    characteristic_uuid: *const c_char,
    data: *const u8,
    data_len: usize,
) -> i32 {
    let (Some(address), Some(service_uuid), Some(characteristic_uuid)) =
        (cstr_arg(address), cstr_arg(service_uuid), cstr_arg(characteristic_uuid))
    else {
        return CARBON_ERR_INVALID;
    };
    let bytes = if data.is_null() || data_len == 0 { Vec::new() } else { core::slice::from_raw_parts(data, data_len).to_vec() };
    match crate::bluetooth::write_characteristic(address, service_uuid, characteristic_uuid, bytes) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Microphone (ABI 1.21) ────────────────────────────────────────────────

#[cfg(feature = "microphone")]
unsafe extern "C" fn host_microphone_start(_app: *mut HostCarbonApp) -> i32 {
    match crate::microphone::start() {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "microphone")]
unsafe extern "C" fn host_microphone_stop(_app: *mut HostCarbonApp) -> i32 {
    match crate::microphone::stop() {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Camera (ABI 1.22) ─────────────────────────────────────────────────────

#[cfg(feature = "camera")]
unsafe extern "C" fn host_camera_start(_app: *mut HostCarbonApp) -> i32 {
    match crate::camera::start() {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

#[cfg(feature = "camera")]
unsafe extern "C" fn host_camera_stop(_app: *mut HostCarbonApp) -> i32 {
    match crate::camera::stop() {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
    }
}

// ── Carbon self-introspection (ABI 1.23) ──────────────────────────────────

unsafe extern "C" fn host_manifest_read(app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char {
    if app.is_null() {
        write_status(out_status, CARBON_ERR_INVALID);
        return core::ptr::null_mut();
    }
    let project_dir = cstr_arg((*app).project_dir).unwrap_or("");
    match crate::carbon_manifest::read(project_dir) {
        Ok(json) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&json)
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

unsafe extern "C" fn host_framecache_stats(_app: *mut HostCarbonApp, out_status: *mut i32) -> *mut c_char {
    match crate::framecache::stats() {
        Ok(json) => {
            write_status(out_status, CARBON_OK);
            alloc_cstring(&json)
        }
        Err(_) => {
            write_status(out_status, CARBON_ERR_GENERIC);
            core::ptr::null_mut()
        }
    }
}

unsafe extern "C" fn host_framecache_clear(app: *mut HostCarbonApp) -> i32 {
    if app.is_null() {
        return CARBON_ERR_INVALID;
    }
    let project_dir = cstr_arg((*app).project_dir).unwrap_or("");
    match crate::framecache::clear(project_dir) {
        Ok(()) => CARBON_OK,
        Err(_) => CARBON_ERR_GENERIC,
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
        backend_name: &str,
        runtime_features_json: &str,
        snapshot_restored: bool,
    ) -> Box<Self> {
        // Empty strings as fallback if the caller passed something invalid.
        let app_name_c = CString::new(app_name).unwrap_or_else(|_| CString::new("").unwrap());
        let app_version_c = CString::new(app_version).unwrap_or_else(|_| CString::new("").unwrap());
        let project_dir_c = CString::new(project_dir).unwrap_or_else(|_| CString::new("").unwrap());
        let backend_name_c = CString::new(backend_name).unwrap_or_else(|_| CString::new("").unwrap());
        let runtime_features_json_c =
            CString::new(runtime_features_json).unwrap_or_else(|_| CString::new("{}").unwrap());

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
                // Each pair below: the real trampoline when that plugin's
                // Cargo feature is on, `None` when it's off (compiled out
                // entirely — see lib.rs's matching `#[cfg(feature = "...")]`
                // on the native/<name>.rs module and this file's own cfg on
                // each host_* fn above). `None` is a normal, already-handled
                // case for every one of these fields — the SDK wrapper
                // (carbon_sdk.zig's CarbonApp methods) already does
                // `self.raw.clipboard_read_text orelse return
                // CARBON_ERR_GENERIC` etc., so a plugin calling a capability
                // its host build doesn't have gets a clean error, not a
                // null-pointer crash.
                #[cfg(feature = "clipboard")]
                clipboard_read_text: Some(host_clipboard_read_text),
                #[cfg(not(feature = "clipboard"))]
                clipboard_read_text: None,
                #[cfg(feature = "clipboard")]
                clipboard_write_text: Some(host_clipboard_write_text),
                #[cfg(not(feature = "clipboard"))]
                clipboard_write_text: None,
                #[cfg(feature = "clipboard")]
                clipboard_clear: Some(host_clipboard_clear),
                #[cfg(not(feature = "clipboard"))]
                clipboard_clear: None,
                #[cfg(feature = "dialog")]
                dialog_open_file: Some(host_dialog_open_file),
                #[cfg(not(feature = "dialog"))]
                dialog_open_file: None,
                #[cfg(feature = "dialog")]
                dialog_open_files: Some(host_dialog_open_files),
                #[cfg(not(feature = "dialog"))]
                dialog_open_files: None,
                #[cfg(feature = "dialog")]
                dialog_open_dir: Some(host_dialog_open_dir),
                #[cfg(not(feature = "dialog"))]
                dialog_open_dir: None,
                #[cfg(feature = "dialog")]
                dialog_save_file: Some(host_dialog_save_file),
                #[cfg(not(feature = "dialog"))]
                dialog_save_file: None,
                #[cfg(feature = "dialog")]
                dialog_open_file_text: Some(host_dialog_open_file_text),
                #[cfg(not(feature = "dialog"))]
                dialog_open_file_text: None,
                #[cfg(feature = "dialog")]
                dialog_save_file_text: Some(host_dialog_save_file_text),
                #[cfg(not(feature = "dialog"))]
                dialog_save_file_text: None,
                #[cfg(feature = "dialog")]
                dialog_message: Some(host_dialog_message),
                #[cfg(not(feature = "dialog"))]
                dialog_message: None,
                #[cfg(feature = "dialog")]
                dialog_confirm: Some(host_dialog_confirm),
                #[cfg(not(feature = "dialog"))]
                dialog_confirm: None,
                #[cfg(feature = "notify")]
                notification_send: Some(host_notification_send),
                #[cfg(not(feature = "notify"))]
                notification_send: None,
                #[cfg(feature = "keychain")]
                keychain_set: Some(host_keychain_set),
                #[cfg(not(feature = "keychain"))]
                keychain_set: None,
                #[cfg(feature = "keychain")]
                keychain_get: Some(host_keychain_get),
                #[cfg(not(feature = "keychain"))]
                keychain_get: None,
                #[cfg(feature = "keychain")]
                keychain_delete: Some(host_keychain_delete),
                #[cfg(not(feature = "keychain"))]
                keychain_delete: None,
                #[cfg(feature = "shortcuts")]
                global_shortcut_register: Some(host_global_shortcut_register),
                #[cfg(not(feature = "shortcuts"))]
                global_shortcut_register: None,
                #[cfg(feature = "shortcuts")]
                global_shortcut_unregister: Some(host_global_shortcut_unregister),
                #[cfg(not(feature = "shortcuts"))]
                global_shortcut_unregister: None,
                #[cfg(feature = "tray")]
                tray_setup: Some(host_tray_setup),
                #[cfg(not(feature = "tray"))]
                tray_setup: None,
                #[cfg(feature = "deeplink")]
                deeplink_register: Some(host_deeplink_register),
                #[cfg(not(feature = "deeplink"))]
                deeplink_register: None,
                #[cfg(feature = "menu")]
                menu_setup: Some(host_menu_setup),
                #[cfg(not(feature = "menu"))]
                menu_setup: None,
                #[cfg(feature = "instance")]
                instance_acquire: Some(host_instance_acquire),
                #[cfg(not(feature = "instance"))]
                instance_acquire: None,
                #[cfg(feature = "sqlite")]
                sqlite_exec: Some(host_sqlite_exec),
                #[cfg(not(feature = "sqlite"))]
                sqlite_exec: None,
                #[cfg(feature = "taskbar")]
                taskbar_set_progress: Some(host_taskbar_set_progress),
                #[cfg(not(feature = "taskbar"))]
                taskbar_set_progress: None,
                #[cfg(feature = "taskbar")]
                taskbar_set_badge: Some(host_taskbar_set_badge),
                #[cfg(not(feature = "taskbar"))]
                taskbar_set_badge: None,
                #[cfg(feature = "theme")]
                theme_query: Some(host_theme_query),
                #[cfg(not(feature = "theme"))]
                theme_query: None,
                #[cfg(feature = "logging")]
                log_write: Some(host_log_write),
                #[cfg(not(feature = "logging"))]
                log_write: None,
                #[cfg(feature = "accessibility")]
                accessibility_query: Some(host_accessibility_query),
                #[cfg(not(feature = "accessibility"))]
                accessibility_query: None,
                #[cfg(feature = "printing")]
                print_file: Some(host_print_file),
                #[cfg(not(feature = "printing"))]
                print_file: None,
                #[cfg(feature = "screencapture")]
                screen_capture: Some(host_screen_capture),
                #[cfg(not(feature = "screencapture"))]
                screen_capture: None,
                #[cfg(feature = "media")]
                media_get_volume: Some(host_media_get_volume),
                #[cfg(not(feature = "media"))]
                media_get_volume: None,
                #[cfg(feature = "media")]
                media_set_volume: Some(host_media_set_volume),
                #[cfg(not(feature = "media"))]
                media_set_volume: None,
                #[cfg(feature = "media")]
                media_get_mute: Some(host_media_get_mute),
                #[cfg(not(feature = "media"))]
                media_get_mute: None,
                #[cfg(feature = "media")]
                media_set_mute: Some(host_media_set_mute),
                #[cfg(not(feature = "media"))]
                media_set_mute: None,
                #[cfg(feature = "media")]
                media_listen_keys: Some(host_media_listen_keys),
                #[cfg(not(feature = "media"))]
                media_listen_keys: None,
                #[cfg(feature = "input")]
                input_modifier_state: Some(host_input_modifier_state),
                #[cfg(not(feature = "input"))]
                input_modifier_state: None,
                #[cfg(feature = "input")]
                input_send_key: Some(host_input_send_key),
                #[cfg(not(feature = "input"))]
                input_send_key: None,
                #[cfg(feature = "input")]
                input_move_mouse: Some(host_input_move_mouse),
                #[cfg(not(feature = "input"))]
                input_move_mouse: None,
                #[cfg(feature = "input")]
                input_click_mouse: Some(host_input_click_mouse),
                #[cfg(not(feature = "input"))]
                input_click_mouse: None,
                #[cfg(feature = "input")]
                input_keyboard_layout: Some(host_input_keyboard_layout),
                #[cfg(not(feature = "input"))]
                input_keyboard_layout: None,
                #[cfg(feature = "biometrics")]
                biometric_verify: Some(host_biometric_verify),
                #[cfg(not(feature = "biometrics"))]
                biometric_verify: None,
                #[cfg(feature = "sharing")]
                share_content: Some(host_share_content),
                #[cfg(not(feature = "sharing"))]
                share_content: None,
                #[cfg(feature = "bluetooth")]
                bluetooth_scan_start: Some(host_bluetooth_scan_start),
                #[cfg(not(feature = "bluetooth"))]
                bluetooth_scan_start: None,
                #[cfg(feature = "bluetooth")]
                bluetooth_scan_stop: Some(host_bluetooth_scan_stop),
                #[cfg(not(feature = "bluetooth"))]
                bluetooth_scan_stop: None,
                #[cfg(feature = "bluetooth")]
                bluetooth_connect: Some(host_bluetooth_connect),
                #[cfg(not(feature = "bluetooth"))]
                bluetooth_connect: None,
                #[cfg(feature = "bluetooth")]
                bluetooth_subscribe: Some(host_bluetooth_subscribe),
                #[cfg(not(feature = "bluetooth"))]
                bluetooth_subscribe: None,
                #[cfg(feature = "bluetooth")]
                bluetooth_write_characteristic: Some(host_bluetooth_write_characteristic),
                #[cfg(not(feature = "bluetooth"))]
                bluetooth_write_characteristic: None,
                #[cfg(feature = "microphone")]
                microphone_start: Some(host_microphone_start),
                #[cfg(not(feature = "microphone"))]
                microphone_start: None,
                #[cfg(feature = "microphone")]
                microphone_stop: Some(host_microphone_stop),
                #[cfg(not(feature = "microphone"))]
                microphone_stop: None,
                #[cfg(feature = "camera")]
                camera_start: Some(host_camera_start),
                #[cfg(not(feature = "camera"))]
                camera_start: None,
                #[cfg(feature = "camera")]
                camera_stop: Some(host_camera_stop),
                #[cfg(not(feature = "camera"))]
                camera_stop: None,
                backend_name: backend_name_c.as_ptr(),
                runtime_features_json: runtime_features_json_c.as_ptr(),
                snapshot_restored: snapshot_restored as i32,
                manifest_read: Some(host_manifest_read),
                framecache_stats: Some(host_framecache_stats),
                framecache_clear: Some(host_framecache_clear),
            },
            _app_name: app_name_c,
            _app_version: app_version_c,
            _project_dir: project_dir_c,
            _backend_name: backend_name_c,
            _runtime_features_json: runtime_features_json_c,
        });
        // Re-bake the string pointers from the now-pinned CStrings (Box's
        // contents have a stable address; the field-init above used the
        // pre-move ptrs which would be invalidated when we boxed).
        storage.app.app_name = storage._app_name.as_ptr();
        storage.app.app_version = storage._app_version.as_ptr();
        storage.app.project_dir = storage._project_dir.as_ptr();
        storage.app.backend_name = storage._backend_name.as_ptr();
        storage.app.runtime_features_json = storage._runtime_features_json.as_ptr();
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
