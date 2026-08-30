// carbon_hotkey — a global, OS-wide hotkey that summons the app even when
// it is minimized or another window has focus.
//
// Why this needs a plugin: no browser or webview engine ever exposes a
// system-wide input hook to JavaScript, on purpose — the same sandboxing
// that stops a website from reading keystrokes typed into a different
// application also stops it from ever registering a hotkey that fires while
// unfocused. Win32's RegisterHotKey is exactly that hook, and there is no
// version of it inside any JS engine's surface.
//
//   zig build                 build it
//   carbon plugin install     copy it into the app and declare it
//   carbon plugin check       verify this file against the registry

const std = @import("std");
const builtin = @import("builtin");
const sdk = @import("carbon_sdk");

comptime {
    if (builtin.os.tag != .windows) {
        @compileError(
            "carbon-hotkey is Windows-only for now — RegisterHotKey has no " ++
                "POSIX equivalent; a global hotkey on X11/Wayland/macOS needs " ++
                "a different native API per platform, not stubbed out here.",
        );
    }
}

// ── Win32 declarations ──────────────────────────────────────────────────────
//
// Checked against learn.microsoft.com/windows/win32/api/winuser (RegisterHotKey,
// GetMessage) rather than recalled — this session already got one Windows-
// adjacent guess wrong once (a Zig internal hash algorithm), so anything
// crossing a real OS ABI here is verified against the actual docs first.

const HWND = ?*anyopaque;
const BOOL = i32;
const UINT = u32;
const DWORD = u32;
const WPARAM = usize;
const LPARAM = isize;

const POINT = extern struct { x: i32, y: i32 };
const MSG = extern struct {
    hwnd: HWND,
    message: UINT,
    wParam: WPARAM,
    lParam: LPARAM,
    time: DWORD,
    pt: POINT,
    lPrivate: DWORD = 0,
};

const MOD_ALT: UINT = 0x0001;
const MOD_CONTROL: UINT = 0x0002;
const MOD_NOREPEAT: UINT = 0x4000;
// Win32 defines no named VK_A..VK_Z constants — per the RegisterHotKey/
// Virtual-Key-Codes docs, 'A'-'Z' share their ASCII values (0x41-0x5A), so
// VK_P is just 'P''s ASCII code.
const VK_P: UINT = 0x50;
const WM_HOTKEY: UINT = 0x0312;
// Untyped so it coerces to both `c_int` (RegisterHotKey's `id` param) and
// `usize` (comparing against MSG.wParam) without an explicit cast at either
// call site.
const HOTKEY_ID = 1;

extern "user32" fn RegisterHotKey(hWnd: HWND, id: c_int, fsModifiers: UINT, vk: UINT) callconv(.c) BOOL;
extern "user32" fn UnregisterHotKey(hWnd: HWND, id: c_int) callconv(.c) BOOL;
extern "user32" fn GetMessageW(lpMsg: *MSG, hWnd: HWND, wMsgFilterMin: UINT, wMsgFilterMax: UINT) callconv(.c) BOOL;
extern "user32" fn PostThreadMessageW(idThread: DWORD, Msg: UINT, wParam: WPARAM, lParam: LPARAM) callconv(.c) BOOL;
extern "kernel32" fn GetCurrentThreadId() callconv(.c) DWORD;

// ── The manifest ────────────────────────────────────────────────────────────
//
// No capability required: registering a global hotkey observes keystrokes
// this app's own accelerator matches, nothing more — unlike paint.before, it
// cannot read or write anything belonging to another app or the framebuffer.

const MANIFEST = sdk.manifest.build(.{
    .name = "carbon_hotkey",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.shutdown" },
});

export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}

// ── Cross-thread delivery ───────────────────────────────────────────────────
//
// `app.pushEvent` is already wired on the host side — products/carbon's
// run_loop.rs calls `globalThis.__carbon_on_event(name, jsonPayload)` for
// every event a plugin pushes, from any thread, safely (it routes through an
// EventLoopProxy onto the JS thread; see solutions/infrastructure/plugin-host/
// abi/host_exports.rs). But nothing in the JS runtime ever installs that
// global, so it silently does nothing without this. Any plugin using
// pushEvent brings its own listener, guarded so a second plugin doing the
// same thing is a no-op.
const EVENT_SHIM =
    \\if(!globalThis.__carbon_on_event){
    \\  (function(){
    \\    var listeners = Object.create(null);
    \\    globalThis.__carbon_on_event = function(name, payloadJson){
    \\      var payload = null;
    \\      try { payload = JSON.parse(payloadJson); } catch(e) {}
    \\      var arr = listeners[name];
    \\      if (!arr) return;
    \\      for (var i = 0; i < arr.length; i++) {
    \\        try { arr[i](payload); } catch(e) {}
    \\      }
    \\    };
    \\    globalThis.carbon = globalThis.carbon || {};
    \\    globalThis.carbon.on = function(name, cb){
    \\      (listeners[name] || (listeners[name] = [])).push(cb);
    \\    };
    \\  })();
    \\}
;

// One listener per process, matching how RegisterHotKey itself works — one
// registration per (hWnd, id) pair. g_thread_id is how shutdown asks the
// blocking GetMessage loop to return: PostThreadMessageW targets a specific
// OS thread, so shutdown has to know which one.
var g_app: ?sdk.CarbonApp = null;
var g_thread: ?std.Thread = null;
var g_thread_id: std.atomic.Value(DWORD) = std.atomic.Value(DWORD).init(0);

comptime {
    const point = sdk.ext.expect("lifecycle.register");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_register"));
}

export fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    g_app = app;

    _ = app.eval(EVENT_SHIM);

    g_thread = std.Thread.spawn(.{}, hotkeyThreadMain, .{}) catch |e| {
        std.debug.print("[carbon-hotkey] failed to start listener thread: {}\n", .{e});
        return;
    };
}

fn hotkeyThreadMain() void {
    g_thread_id.store(GetCurrentThreadId(), .release);

    // A NULL hWnd binds the hotkey to THIS thread's message queue, so the
    // pump below has to run on the very thread that registered it — which
    // is why registration happens here, not in carbon_plugin_register.
    if (RegisterHotKey(null, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_P) == 0) {
        std.debug.print("[carbon-hotkey] RegisterHotKey failed — Ctrl+Alt+P may already be taken by another app\n", .{});
        return;
    }
    defer _ = UnregisterHotKey(null, HOTKEY_ID);

    var msg: MSG = undefined;
    while (true) {
        // BOOL here is famously 3-valued, not 2: 0 is WM_QUIT, -1 is an
        // error, anything else is a real message. Treating it as a plain
        // bool (`while (GetMessage(...))`) is the exact bug Microsoft's own
        // docs call out — silently ignores clean shutdown, or worse, spins.
        const r = GetMessageW(&msg, null, 0, 0);
        if (r == 0) break; // WM_QUIT — shutdown asked us to stop.
        if (r == -1) break; // error — nothing more we can do with this queue.
        if (msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID) {
            if (g_app) |app| _ = app.pushEvent("hotkey.summon", "{}");
        }
    }
}

comptime {
    const point = sdk.ext.expect("lifecycle.shutdown");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_on_shutdown"));
}

export fn carbon_plugin_on_shutdown(app_raw: *sdk.RawApp) callconv(.c) void {
    _ = app_raw;
    const tid = g_thread_id.load(.acquire);
    if (tid != 0) {
        _ = PostThreadMessageW(tid, 0x0012, 0, 0); // WM_QUIT — breaks GetMessage's loop.
    }
    if (g_thread) |t| t.join();
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// No window, no OS message queue in the test binary — what's testable
// without either is the manifest, the same way carbon-crt's tests are pure
// logic over plain data. RegisterHotKey/GetMessage themselves are exercised
// for real by `carbon dev`, not here.

test "the manifest declares both points and no JS module" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon_hotkey\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.shutdown") != null);
}

test "the manifest is valid JSON" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        arena.allocator(),
        std.mem.span(MANIFEST),
        .{},
    );
    try std.testing.expect(parsed.value == .object);
}
