// carbon_sdk.zig — Zig wrappers around the Carbon plugin C ABI.
//
// Most plugin authors only need:
//   * `CarbonApp` (the host descriptor)
//   * `manifest.build` (the manifest, composed at comptime)
//   * `ext.expect` (comptime-check an extension point id)
//   * `setGlobalString` / `setGlobalNumber` / `setGlobalFunction` helpers
//   * `pushEvent` for cross-thread events
//
// The C ABI itself is in `../include/carbon_plugin.h`. We re-import it via
// @cInclude inside this module so the constants stay in lockstep.
//
// The EXTENSION POINTS — what a plugin can actually plug into — are in
// `extension_points.zig`, which re-exports
// `contracts/plugin/registry/extension-points.zig` verbatim. A plugin author
// reading that file is reading the same declaration the runtime's dispatch
// table was generated from.

const std = @import("std");

/// The extension-point registry, and the comptime helpers that check an id.
pub const ext = @import("extension_points.zig");

/// The comptime manifest builder.
pub const manifest = @import("manifest.zig");

/// Cross-thread event helpers.
pub const push = @import("push.zig");

pub const c = @cImport({
    @cInclude("carbon_plugin.h");
});

pub const ABI_VERSION_MAJOR: u32 = c.CARBON_PLUGIN_ABI_VERSION_MAJOR;
pub const ABI_VERSION_MINOR: u32 = c.CARBON_PLUGIN_ABI_VERSION_MINOR;

pub const CARBON_OK: i32 = c.CARBON_OK;
pub const CARBON_ERR_GENERIC: i32 = c.CARBON_ERR_GENERIC;
pub const CARBON_ERR_INVALID: i32 = c.CARBON_ERR_INVALID;
pub const CARBON_ERR_QUEUE_FULL: i32 = c.CARBON_ERR_QUEUE_FULL;
pub const CARBON_ERR_NO_CTX: i32 = c.CARBON_ERR_NO_CTX;

/// Re-export the raw C struct so plugins that need to dereference fields
/// directly can do so. Most should prefer the helpers below.
pub const RawApp = c.CarbonApp;
pub const RawJsContext = c.CarbonJSContext;

// carbon_plugin.h's "RESOLUTION MODEL" comment (above the carbon_js_*
// declarations) explains why the four methods below (setGlobalString,
// setGlobalNumber, setGlobalFunction, eval) call through
// `self.raw.set_global_*`/`self.raw.eval` function pointers rather than
// resolving `carbon_js_*` symbols at load time: those pointers are ABI 1.1
// fields on `CarbonApp` itself, filled in by the host before
// `carbon_plugin_register` runs — the same shape `request_paint` and
// `push_event` already use — specifically so this SDK never needs
// GetProcAddress/GetModuleHandleW (or dlsym/RTLD_DEFAULT on POSIX) at all.
// The plugin trust checker (solutions/capabilities/plugin/trust) denies
// those two symbol families from a compiled plugin's import table
// unconditionally, for every module, because a plugin that can resolve one
// arbitrary OS symbol at runtime can resolve any of them — and every
// legitimate Carbon plugin calls at least one of these four, so an SDK that
// still resolved them dynamically would fail its own trust check by
// construction. This is not a workaround for the checker; it closes a real
// gap the checker's own design doc names: "no static import-table check
// means anything" once dynamic resolution is available at all.

/// A safe-ish view over a `*c.CarbonApp` pointer. Construct one inside
/// each entry point with `CarbonApp.fromRaw(app)`.
pub const CarbonApp = struct {
    raw: *c.CarbonApp,

    pub fn fromRaw(raw: *c.CarbonApp) CarbonApp {
        return .{ .raw = raw };
    }

    pub fn abiVersion(self: CarbonApp) struct { major: u32, minor: u32 } {
        return .{ .major = self.raw.abi_version_major, .minor = self.raw.abi_version_minor };
    }

    pub fn abiCompatible(self: CarbonApp) bool {
        return self.raw.abi_version_major == ABI_VERSION_MAJOR;
    }

    pub fn windowSize(self: CarbonApp) struct { w: u32, h: u32 } {
        return .{ .w = self.raw.window_width, .h = self.raw.window_height };
    }

    pub fn jsContext(self: CarbonApp) ?*c.CarbonJSContext {
        return self.raw.js_ctx;
    }

    pub fn requestPaint(self: CarbonApp) void {
        if (self.raw.request_paint) |f| f(self.raw);
    }

    pub fn pushEvent(self: CarbonApp, name: [*:0]const u8, json_payload: [*:0]const u8) i32 {
        const f = self.raw.push_event orelse return CARBON_ERR_INVALID;
        return f(self.raw, name, json_payload);
    }

    pub fn setGlobalString(self: CarbonApp, name: [*:0]const u8, value: [*:0]const u8) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.set_global_string orelse return CARBON_ERR_GENERIC;
        return f(ctx, name, value);
    }

    pub fn setGlobalNumber(self: CarbonApp, name: [*:0]const u8, value: f64) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.set_global_number orelse return CARBON_ERR_GENERIC;
        return f(ctx, name, value);
    }

    pub fn setGlobalFunction(self: CarbonApp, name: [*:0]const u8, cb: c.CarbonJSCallback) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.set_global_function orelse return CARBON_ERR_GENERIC;
        return f(ctx, name, cb);
    }

    pub fn eval(self: CarbonApp, source: [*:0]const u8) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.eval orelse return CARBON_ERR_GENERIC;
        return f(ctx, source);
    }

    /// ABI 1.2. Load a TTF/OTF font from a filesystem path into the text
    /// engine, optionally registered under `family` so `font-family:
    /// "<family>"` in CSS/JSX selects this exact face afterward. Pass
    /// `null` for `family` to load anonymously (coverage-fallback only).
    /// `weight` is the CSS font-weight scale (1-1000; 0 = default 400) —
    /// load the same family at multiple weights for real bold/semibold
    /// instead of a fallback substitution. Runs synchronously — the return
    /// value is the real result, not a "queued" placeholder.
    pub fn loadFontPath(self: CarbonApp, path: [*:0]const u8, family: ?[*:0]const u8, weight: u32) i32 {
        const f = self.raw.load_font_path orelse return CARBON_ERR_GENERIC;
        return f(self.raw, path, family orelse null, weight);
    }

    /// Same as `loadFontPath`, from raw bytes already in memory (e.g. an
    /// app-bundled asset read by the plugin itself rather than resolved
    /// from a path on disk).
    pub fn loadFontBytes(self: CarbonApp, bytes: []const u8, family: ?[*:0]const u8, weight: u32) i32 {
        const f = self.raw.load_font_bytes orelse return CARBON_ERR_GENERIC;
        return f(self.raw, bytes.ptr, bytes.len, family orelse null, weight);
    }

    // ── ABI 1.3: clipboard / dialog / notification / keychain ─────────────
    //
    // String-returning calls here return the raw, possibly-null C pointer
    // (`[*c]u8`) exactly as the ABI hands it back — non-null means it was
    // allocated via `app->alloc` and the CALLER (this plugin) owns it: read
    // it with `std.mem.span(ptr)`, then free it with `self.freeString(ptr)`
    // once done. `out_status` follows carbon_plugin.h's contract: CARBON_OK
    // means the call succeeded and the pointer is authoritative as-is (null
    // there is a real "cancelled"/"empty", not a failure).

    /// Free a string previously returned by one of the calls below.
    /// No-op if `ptr` is null.
    pub fn freeString(self: CarbonApp, ptr: [*c]u8) void {
        if (ptr == null) return;
        if (self.raw.free) |f| f(ptr);
    }

    pub fn clipboardReadText(self: CarbonApp, out_status: *i32) [*c]u8 {
        const f = self.raw.clipboard_read_text orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, out_status);
    }

    pub fn clipboardWriteText(self: CarbonApp, text: [*:0]const u8) i32 {
        const f = self.raw.clipboard_write_text orelse return CARBON_ERR_GENERIC;
        return f(self.raw, text);
    }

    pub fn clipboardClear(self: CarbonApp) i32 {
        const f = self.raw.clipboard_clear orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }

    /// `opts_json`: `{"title"?, "defaultPath"?, "filters"?: [{"name",
    /// "extensions":[...]}]}` — same shape for every dialog_* call below.
    pub fn dialogOpenFile(self: CarbonApp, opts_json: [*:0]const u8, out_status: *i32) [*c]u8 {
        const f = self.raw.dialog_open_file orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, opts_json, out_status);
    }

    /// Returned string, if non-null, is a JSON array of paths.
    pub fn dialogOpenFiles(self: CarbonApp, opts_json: [*:0]const u8, out_status: *i32) [*c]u8 {
        const f = self.raw.dialog_open_files orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, opts_json, out_status);
    }

    pub fn dialogOpenDir(self: CarbonApp, opts_json: [*:0]const u8, out_status: *i32) [*c]u8 {
        const f = self.raw.dialog_open_dir orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, opts_json, out_status);
    }

    pub fn dialogSaveFile(self: CarbonApp, opts_json: [*:0]const u8, out_status: *i32) [*c]u8 {
        const f = self.raw.dialog_save_file orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, opts_json, out_status);
    }

    /// Shows the picker and returns the chosen file's CONTENT, not its
    /// path — see carbon_plugin.h's note on why: no raw filesystem path
    /// the user picked ever has to reach JS.
    pub fn dialogOpenFileText(self: CarbonApp, opts_json: [*:0]const u8, out_status: *i32) [*c]u8 {
        const f = self.raw.dialog_open_file_text orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, opts_json, out_status);
    }

    /// Returns 1 if written, 0 if the user cancelled, negative on error.
    pub fn dialogSaveFileText(self: CarbonApp, opts_json: [*:0]const u8, content: [*:0]const u8) i32 {
        const f = self.raw.dialog_save_file_text orelse return CARBON_ERR_GENERIC;
        return f(self.raw, opts_json, content);
    }

    /// `level`: "info" | "warning" | "error".
    pub fn dialogMessage(self: CarbonApp, title: [*:0]const u8, body: [*:0]const u8, level: [*:0]const u8) i32 {
        const f = self.raw.dialog_message orelse return CARBON_ERR_GENERIC;
        return f(self.raw, title, body, level);
    }

    /// Returns 1 if the user picked Yes, 0 for No, negative on error.
    pub fn dialogConfirm(self: CarbonApp, title: [*:0]const u8, body: [*:0]const u8) i32 {
        const f = self.raw.dialog_confirm orelse return CARBON_ERR_GENERIC;
        return f(self.raw, title, body);
    }

    /// `icon_path` may be an empty string for the system default icon.
    pub fn notificationSend(self: CarbonApp, title: [*:0]const u8, body: [*:0]const u8, icon_path: [*:0]const u8) i32 {
        const f = self.raw.notification_send orelse return CARBON_ERR_GENERIC;
        return f(self.raw, title, body, icon_path);
    }

    pub fn keychainSet(self: CarbonApp, service: [*:0]const u8, account: [*:0]const u8, password: [*:0]const u8) i32 {
        const f = self.raw.keychain_set orelse return CARBON_ERR_GENERIC;
        return f(self.raw, service, account, password);
    }

    /// `out_status` distinguishes CARBON_OK (found), CARBON_NOT_FOUND (no
    /// entry — not an error) and CARBON_ERR_GENERIC (a real failure).
    pub fn keychainGet(self: CarbonApp, service: [*:0]const u8, account: [*:0]const u8, out_status: *i32) [*c]u8 {
        const f = self.raw.keychain_get orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, service, account, out_status);
    }

    pub fn keychainDelete(self: CarbonApp, service: [*:0]const u8, account: [*:0]const u8) i32 {
        const f = self.raw.keychain_delete orelse return CARBON_ERR_GENERIC;
        return f(self.raw, service, account);
    }

    // ── ABI 1.4: global keyboard shortcuts ─────────────────────────────────

    /// `accelerator` e.g. "Ctrl+Alt+P". `out_id` receives the id that will
    /// tag every `global-shortcut.fired` event for this accelerator.
    pub fn globalShortcutRegister(self: CarbonApp, accelerator: [*:0]const u8, out_id: *u32) i32 {
        const f = self.raw.global_shortcut_register orelse return CARBON_ERR_GENERIC;
        return f(self.raw, accelerator, out_id);
    }

    pub fn globalShortcutUnregister(self: CarbonApp, accelerator: [*:0]const u8) i32 {
        const f = self.raw.global_shortcut_unregister orelse return CARBON_ERR_GENERIC;
        return f(self.raw, accelerator);
    }

    // ── ABI 1.5: system tray ────────────────────────────────────────────────

    /// `icon_path`: a PNG file. `tooltip`/`menu_items_json` may be empty
    /// strings for "none". A second call after the tray is already set up
    /// is a no-op (still returns CARBON_OK).
    pub fn traySetup(
        self: CarbonApp,
        icon_path: [*:0]const u8,
        tooltip: [*:0]const u8,
        menu_items_json: [*:0]const u8,
    ) i32 {
        const f = self.raw.tray_setup orelse return CARBON_ERR_GENERIC;
        return f(self.raw, icon_path, tooltip, menu_items_json);
    }

    // ── ABI 1.6: deep linking ────────────────────────────────────────────

    /// May not return at all — a forwarded launch exits the process
    /// directly (see carbon_plugin.h's note on this field).
    pub fn deeplinkRegister(self: CarbonApp, scheme: [*:0]const u8) i32 {
        const f = self.raw.deeplink_register orelse return CARBON_ERR_GENERIC;
        return f(self.raw, scheme);
    }

    // ── ABI 1.7: native application menu bar ────────────────────────────────

    /// `menu_json`: the top-level-menus array documented on `menu_setup` in
    /// carbon_plugin.h. Replaces any previously-set menu — unlike
    /// `traySetup`, a second call is NOT a no-op.
    pub fn menuSetup(self: CarbonApp, menu_json: [*:0]const u8) i32 {
        const f = self.raw.menu_setup orelse return CARBON_ERR_GENERIC;
        return f(self.raw, menu_json);
    }

    // ── ABI 1.8: single-instance lock ───────────────────────────────────────

    /// May not return at all if another instance already holds the lock —
    /// the calling process exits directly (see carbon_plugin.h's note on
    /// this field, same contract as `deeplinkRegister`).
    pub fn instanceAcquire(self: CarbonApp, app_id: [*:0]const u8) i32 {
        const f = self.raw.instance_acquire orelse return CARBON_ERR_GENERIC;
        return f(self.raw, app_id);
    }

    // ── ABI 1.9: embedded SQLite storage ────────────────────────────────────

    /// `params_json`: a JSON array, or an empty string for none. Returns
    /// an allocated JSON string the caller must free via `freeString`, or
    /// null on any status other than CARBON_OK.
    pub fn sqliteExec(
        self: CarbonApp,
        db_path: [*:0]const u8,
        sql: [*:0]const u8,
        params_json: [*:0]const u8,
        out_status: *i32,
    ) [*c]u8 {
        const f = self.raw.sqlite_exec orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, db_path, sql, params_json, out_status);
    }

    // ── ABI 1.10: taskbar badge and progress ────────────────────────────────

    /// `total == 0` clears the progress overlay.
    pub fn taskbarSetProgress(self: CarbonApp, completed: u64, total: u64) i32 {
        const f = self.raw.taskbar_set_progress orelse return CARBON_ERR_GENERIC;
        return f(self.raw, completed, total);
    }

    /// `icon_path` empty clears the overlay icon.
    pub fn taskbarSetBadge(self: CarbonApp, icon_path: [*:0]const u8, description: [*:0]const u8) i32 {
        const f = self.raw.taskbar_set_badge orelse return CARBON_ERR_GENERIC;
        return f(self.raw, icon_path, description);
    }

    // ── ABI 1.11: theme preferences ─────────────────────────────────────────

    /// Returns an allocated JSON string the caller must free via
    /// `freeString`, or null on any status other than CARBON_OK.
    pub fn themeQuery(self: CarbonApp, out_status: *i32) [*c]u8 {
        const f = self.raw.theme_query orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, out_status);
    }

    // ── ABI 1.12: structured file logging ───────────────────────────────────

    pub fn logWrite(self: CarbonApp, path: [*:0]const u8, level: [*:0]const u8, message: [*:0]const u8) i32 {
        const f = self.raw.log_write orelse return CARBON_ERR_GENERIC;
        return f(self.raw, path, level, message);
    }

    // ── ABI 1.13: screen-reader detection ───────────────────────────────────

    pub fn accessibilityQuery(self: CarbonApp, out_active: *i32) i32 {
        const f = self.raw.accessibility_query orelse return CARBON_ERR_GENERIC;
        return f(self.raw, out_active);
    }

    // ── ABI 1.14: printing ───────────────────────────────────────────────────

    pub fn printFile(self: CarbonApp, path: [*:0]const u8) i32 {
        const f = self.raw.print_file orelse return CARBON_ERR_GENERIC;
        return f(self.raw, path);
    }

    // ── ABI 1.15: screen capture ─────────────────────────────────────────────

    pub fn screenCapture(self: CarbonApp, target: [*:0]const u8, out_path: [*:0]const u8) i32 {
        const f = self.raw.screen_capture orelse return CARBON_ERR_GENERIC;
        return f(self.raw, target, out_path);
    }

    // ── ABI 1.16: system audio volume/mute and media-key handling ──────────

    pub fn mediaGetVolume(self: CarbonApp, out_level: *f32) i32 {
        const f = self.raw.media_get_volume orelse return CARBON_ERR_GENERIC;
        return f(self.raw, out_level);
    }
    pub fn mediaSetVolume(self: CarbonApp, level: f32) i32 {
        const f = self.raw.media_set_volume orelse return CARBON_ERR_GENERIC;
        return f(self.raw, level);
    }
    pub fn mediaGetMute(self: CarbonApp, out_muted: *i32) i32 {
        const f = self.raw.media_get_mute orelse return CARBON_ERR_GENERIC;
        return f(self.raw, out_muted);
    }
    pub fn mediaSetMute(self: CarbonApp, muted: i32) i32 {
        const f = self.raw.media_set_mute orelse return CARBON_ERR_GENERIC;
        return f(self.raw, muted);
    }
    pub fn mediaListenKeys(self: CarbonApp) i32 {
        const f = self.raw.media_listen_keys orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }

    // ── ABI 1.17: input ──────────────────────────────────────────────────────

    pub fn inputModifierState(self: CarbonApp, out_status: *i32) [*c]u8 {
        const f = self.raw.input_modifier_state orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, out_status);
    }
    pub fn inputSendKey(self: CarbonApp, vk: u16, key_down: i32) i32 {
        const f = self.raw.input_send_key orelse return CARBON_ERR_GENERIC;
        return f(self.raw, vk, key_down);
    }
    pub fn inputMoveMouse(self: CarbonApp, x: i32, y: i32) i32 {
        const f = self.raw.input_move_mouse orelse return CARBON_ERR_GENERIC;
        return f(self.raw, x, y);
    }
    pub fn inputClickMouse(self: CarbonApp, button: i32, is_down: i32) i32 {
        const f = self.raw.input_click_mouse orelse return CARBON_ERR_GENERIC;
        return f(self.raw, button, is_down);
    }
    pub fn inputKeyboardLayout(self: CarbonApp, out_status: *i32) [*c]u8 {
        const f = self.raw.input_keyboard_layout orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, out_status);
    }

    // ── ABI 1.18: biometrics ────────────────────────────────────────────────

    /// Dispatches a Windows Hello verification request and returns
    /// immediately — the actual verified/not-verified outcome arrives
    /// later as a `biometrics.result` event, not as this call's return
    /// value. See carbon_plugin.h's ABI 1.18 doc comment for why.
    pub fn biometricVerify(self: CarbonApp, message: [*:0]const u8) i32 {
        const f = self.raw.biometric_verify orelse return CARBON_ERR_GENERIC;
        return f(self.raw, message);
    }

    // ── ABI 1.19: sharing ────────────────────────────────────────────────────

    /// `title`/`text`/`url` are each empty-safe (pass "" for any unused).
    /// Returns once the share flyout has been shown, not once the user has
    /// picked a target — see carbon_plugin.h's ABI 1.19 doc comment.
    pub fn shareContent(self: CarbonApp, title: [*:0]const u8, text: [*:0]const u8, url: [*:0]const u8) i32 {
        const f = self.raw.share_content orelse return CARBON_ERR_GENERIC;
        return f(self.raw, title, text, url);
    }

    // ── ABI 1.20: bluetooth ──────────────────────────────────────────────────
    // Every call below returns once DISPATCHED, not once the underlying
    // operation completes — see carbon_plugin.h's ABI 1.20 doc comment.

    pub fn bluetoothScanStart(self: CarbonApp) i32 {
        const f = self.raw.bluetooth_scan_start orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }
    pub fn bluetoothScanStop(self: CarbonApp) i32 {
        const f = self.raw.bluetooth_scan_stop orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }
    pub fn bluetoothConnect(self: CarbonApp, address: [*:0]const u8) i32 {
        const f = self.raw.bluetooth_connect orelse return CARBON_ERR_GENERIC;
        return f(self.raw, address);
    }
    pub fn bluetoothSubscribe(self: CarbonApp, address: [*:0]const u8, service_uuid: [*:0]const u8, characteristic_uuid: [*:0]const u8) i32 {
        const f = self.raw.bluetooth_subscribe orelse return CARBON_ERR_GENERIC;
        return f(self.raw, address, service_uuid, characteristic_uuid);
    }
    pub fn bluetoothWriteCharacteristic(
        self: CarbonApp,
        address: [*:0]const u8,
        service_uuid: [*:0]const u8,
        characteristic_uuid: [*:0]const u8,
        data: []const u8,
    ) i32 {
        const f = self.raw.bluetooth_write_characteristic orelse return CARBON_ERR_GENERIC;
        return f(self.raw, address, service_uuid, characteristic_uuid, data.ptr, data.len);
    }

    // ── ABI 1.21: microphone ─────────────────────────────────────────────────

    pub fn microphoneStart(self: CarbonApp) i32 {
        const f = self.raw.microphone_start orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }
    pub fn microphoneStop(self: CarbonApp) i32 {
        const f = self.raw.microphone_stop orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }

    // ── ABI 1.22: camera ─────────────────────────────────────────────────────

    pub fn cameraStart(self: CarbonApp) i32 {
        const f = self.raw.camera_start orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }
    pub fn cameraStop(self: CarbonApp) i32 {
        const f = self.raw.camera_stop orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }

    // ── ABI 1.23: Carbon self-introspection ──────────────────────────────────
    // Not an OS/cloud capability — backend/runtime/manifest/framecache/
    // snapshot state Carbon's own composition root already knows about.

    /// "mini" or "blitz". Plain field, static for the process lifetime —
    /// no ABI-1.0-runtime fallback needed since older host runtimes
    /// simply predate this field entirely (caught by `abiCompatible`).
    pub fn backendName(self: CarbonApp) [*c]const u8 {
        return self.raw.backend_name;
    }

    /// A JSON object of THIS binary's own compiled-in Cargo feature
    /// flags — see carbon_plugin.h's ABI 1.23 doc comment for the exact
    /// shape. Never `null`; `"{}"` on a host runtime that predates this
    /// field (won't happen in practice — see `backendName`'s note).
    pub fn runtimeFeaturesJson(self: CarbonApp) [*c]const u8 {
        return self.raw.runtime_features_json;
    }

    /// Whether THIS session's JS runtime was restored from a pre-built
    /// QuickJS heap snapshot rather than freshly evaluating the bundle.
    pub fn snapshotRestored(self: CarbonApp) bool {
        return self.raw.snapshot_restored != 0;
    }

    /// Re-parses the app's own carbon.toml fresh on every call. Returns
    /// an allocated JSON string the caller must free via `freeString`, or
    /// null on any status other than CARBON_OK (missing/malformed
    /// carbon.toml).
    pub fn manifestRead(self: CarbonApp, out_status: *i32) [*c]u8 {
        const f = self.raw.manifest_read orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, out_status);
    }

    /// Returns an allocated JSON string (`{"hit":bool}`) the caller must
    /// free via `freeString` — whether THIS launch's first frame was
    /// served from the warm-start disk cache. Always `hit:false` on a
    /// backend with no such cache (blitz).
    pub fn framecacheStats(self: CarbonApp, out_status: *i32) [*c]u8 {
        const f = self.raw.framecache_stats orelse {
            out_status.* = CARBON_ERR_GENERIC;
            return null;
        };
        return f(self.raw, out_status);
    }

    /// Deletes the on-disk warm-start cache for the current project,
    /// forcing the next launch to rebuild it. CARBON_OK even if there
    /// was nothing to clear.
    pub fn framecacheClear(self: CarbonApp) i32 {
        const f = self.raw.framecache_clear orelse return CARBON_ERR_GENERIC;
        return f(self.raw);
    }
};

/// Compose a manifest JSON string at comptime.
///
/// DEPRECATED — use `manifest.build`, which derives the capability list from
/// the extension points the plugin declares instead of asking the author to
/// keep the two in agreement by hand. Kept because plugins written against
/// ABI 1.0 call it, and it still produces a manifest the loader accepts.
pub fn buildManifestJson(comptime cfg: ManifestConfig) []const u8 {
    @setEvalBranchQuota(10_000);
    return std.fmt.comptimePrint(
        \\{{"name":"{s}","version":"{s}","abi_version_major":{d},"abi_version_minor":{d},"capabilities":{{"required":{s},"optional":{s}}},"modules":{s},"lifecycle_hooks":{s}}}
    , .{
        cfg.name,
        cfg.version,
        cfg.abi_version_major,
        cfg.abi_version_minor,
        jsonStringArray(cfg.required),
        jsonStringArray(cfg.optional),
        jsonStringArray(cfg.modules),
        jsonStringArray(cfg.hooks),
    });
}

pub const ManifestConfig = struct {
    name: []const u8,
    version: []const u8,
    abi_version_major: u32 = ABI_VERSION_MAJOR,
    abi_version_minor: u32 = ABI_VERSION_MINOR,
    required: []const []const u8 = &.{},
    optional: []const []const u8 = &.{},
    modules: []const []const u8 = &.{},
    hooks: []const []const u8 = &.{},
};

fn jsonStringArray(comptime arr: []const []const u8) []const u8 {
    if (arr.len == 0) return "[]";
    comptime var out: []const u8 = "[";
    inline for (arr, 0..) |s, i| {
        if (i > 0) out = out ++ ",";
        out = out ++ "\"" ++ s ++ "\"";
    }
    out = out ++ "]";
    return out;
}

test "the deprecated manifest builder still produces what the loader parses" {
    const want =
        \\{"name":"hello","version":"0.1.0","abi_version_major":1,"abi_version_minor":1,"capabilities":{"required":[],"optional":["fs.read"]},"modules":["carbon:hello"],"lifecycle_hooks":["register"]}
    ;
    const got = comptime buildManifestJson(.{
        .name = "hello",
        .version = "0.1.0",
        .optional = &.{"fs.read"},
        .modules = &.{"carbon:hello"},
        .hooks = &.{"register"},
    });
    try std.testing.expectEqualStrings(want, got);
}
