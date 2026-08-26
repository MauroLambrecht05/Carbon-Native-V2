// carbon_idle — system-wide idle detection: how long since the OS last saw
// *any* keyboard or mouse input, anywhere, not just events aimed at this
// window.
//
// Why this needs a plugin: a web page or webview only ever receives input
// events targeted at itself — focus a different window and the page sees
// nothing at all, forever, no matter how long the user is actually away
// from the machine. Win32's GetLastInputInfo answers a different question
// ("when did the OS last see input from any source") that no JS engine has
// a way to ask. This is the same mechanism Slack's "away" status and most
// time-tracking software use.
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
            "carbon-idle is Windows-only for now — GetLastInputInfo has no " ++
                "POSIX equivalent; X11/Wayland/macOS idle detection needs a " ++
                "different native API per platform, not stubbed out here.",
        );
    }
}

// ── Win32 declarations ──────────────────────────────────────────────────────
//
// Checked against learn.microsoft.com/windows/win32/api/winuser
// (GetLastInputInfo, LASTINPUTINFO) rather than recalled.

const BOOL = i32;
const UINT = u32;
const DWORD = u32;

const LASTINPUTINFO = extern struct {
    cbSize: UINT,
    dwTime: DWORD,
};

extern "user32" fn GetLastInputInfo(plii: *LASTINPUTINFO) callconv(.c) BOOL;
extern "kernel32" fn GetTickCount() callconv(.c) DWORD;
extern "kernel32" fn Sleep(dwMilliseconds: DWORD) callconv(.c) void;

/// Seconds of no keyboard/mouse input anywhere on the system. `-%` (wrapping
/// subtraction) because GetTickCount wraps every ~49.7 days — plain `-`
/// would be undefined-behavior-checked overflow on the one measurement that
/// crosses that boundary, and the wrapped result is still the right answer
/// (modular arithmetic recovers the true elapsed time either side of a wrap).
fn secondsSinceInput() ?u32 {
    var info = LASTINPUTINFO{ .cbSize = @sizeOf(LASTINPUTINFO), .dwTime = 0 };
    if (GetLastInputInfo(&info) == 0) return null;
    const elapsed_ms = GetTickCount() -% info.dwTime;
    return elapsed_ms / 1000;
}

// ── The manifest ────────────────────────────────────────────────────────────

const MANIFEST = sdk.manifest.build(.{
    .name = "carbon_idle",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.shutdown" },
    .modules = &.{"carbon:carbon-idle"},
});

export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}

// Same idempotent event-dispatcher shim as carbon-hotkey — see that plugin
// for why it exists. Each plugin using pushEvent carries its own copy
// because there is no shared JS bootstrap between plugins to put it in;
// the guard makes a second copy a no-op.
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

// Away after one minute of nobody touching the keyboard or mouse — long
// enough that reaching for a coffee doesn't flip it, short enough that a
// focus timer actually pauses when the user has left.
const IDLE_THRESHOLD_SECONDS: u32 = 60;
const POLL_INTERVAL_MS: DWORD = 1000;

var g_app: ?sdk.CarbonApp = null;
var g_thread: ?std.Thread = null;
var g_stop = std.atomic.Value(bool).init(false);

comptime {
    const point = sdk.ext.expect("lifecycle.register");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_register"));
}

export fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    g_app = app;

    _ = app.eval(EVENT_SHIM);
    _ = app.setGlobalFunction("__carbon_idle_seconds", jsSecondsIdle);

    g_thread = std.Thread.spawn(.{}, pollThreadMain, .{}) catch |e| {
        std.debug.print("[carbon-idle] failed to start poll thread: {}\n", .{e});
        return;
    };
}

fn pollThreadMain() void {
    var was_idle = false;
    while (!g_stop.load(.acquire)) {
        Sleep(POLL_INTERVAL_MS);
        const seconds = secondsSinceInput() orelse continue;
        const is_idle = seconds >= IDLE_THRESHOLD_SECONDS;
        if (is_idle == was_idle) continue; // No transition — nothing to report.
        was_idle = is_idle;

        var buf: [64]u8 = undefined;
        const payload = std.fmt.bufPrintZ(
            &buf,
            "{{\"idle\":{s},\"seconds\":{d}}}",
            .{ if (is_idle) "true" else "false", seconds },
        ) catch continue;
        if (g_app) |app| _ = app.pushEvent("idle.changed", payload);
    }
}

fn jsSecondsIdle(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    var buf: [32]u8 = undefined;
    if (secondsSinceInput()) |s| {
        const json = std.fmt.bufPrint(&buf, "{d}", .{s}) catch {
            return writeResult(result_buf, result_buf_len, "null");
        };
        writeResult(result_buf, result_buf_len, json);
    } else {
        writeResult(result_buf, result_buf_len, "null");
    }
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return; // Never happens for a plain number, but stay safe.
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

comptime {
    const point = sdk.ext.expect("lifecycle.shutdown");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_on_shutdown"));
}

export fn carbon_plugin_on_shutdown(app_raw: *sdk.RawApp) callconv(.c) void {
    _ = app_raw;
    g_stop.store(true, .release);
    // Sleep(1000) inside the loop means shutdown waits at most one poll
    // interval — acceptable; the alternative (a Win32 event object to wake
    // it early) is real complexity for a sub-second worst case.
    if (g_thread) |t| t.join();
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and the carbon:carbon-idle module" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon_idle\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.shutdown") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "carbon:carbon-idle") != null);
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
