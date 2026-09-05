// media — system audio volume/mute and hardware media-key handling
// (Windows only for now; see the media_* fields' own doc comment in
// carbon_plugin.h and the host-side media.rs header for the full scope
// note — now-playing metadata and a video decode surface are NOT covered
// here, a separate, larger piece of work).
//
//   carbon plugin add media
//
//   import { getVolume, setVolume, getMuted, setMuted, listenMediaKeys } from "@carbon/plugins/media";
//   setVolume(0.5);
//   listenMediaKeys();
//   carbon.on("media.key", ({ key }) => console.log(key)); // "playpause"|"next"|"previous"|"stop"
//
//   zig build              build it
//   carbon plugin add media fetch + build + install into the current app
//   carbon plugin check    verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "media",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:media"},
    .exports = &.{
        .{ .name = "getVolume" },
        .{ .name = "setVolume" },
        .{ .name = "getMuted" },
        .{ .name = "setMuted" },
        .{ .name = "listenMediaKeys" },
    },
    .abi_version_major = sdk.ABI_VERSION_MAJOR,
    .abi_version_minor = sdk.ABI_VERSION_MINOR,
};

const MANIFEST = sdk.manifest.build(CFG);

pub fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}
comptime {
    sdk.ext.implementManifest(carbon_plugin_manifest);
}

var g_app: ?sdk.CarbonApp = null;

// ── JS listener shim — see global-shortcuts' main.zig for the full
// rationale (same shim, `carbon.on`/`carbon.off`, guarded so a second
// plugin installing it is a no-op). Needed so `media.key` events from
// `listenMediaKeys()` are actually deliverable.
// Each of the five pieces below is independently idempotent-guarded
// against a NAMED global (not a closure-private variable) — needed since
// a plugin that only ever calls `carbon.on` (e.g. tray, menu) and one
// that also delivers binary events (e.g. a camera/microphone/bluetooth
// plugin) may install this shim in either order; whichever runs first
// must not shadow-out a piece the other one still needs to add.
const EVENT_SHIM =
    \\if(!globalThis.__carbon_event_listeners){
    \\  globalThis.__carbon_event_listeners = Object.create(null);
    \\}
    \\if(!globalThis.carbon){ globalThis.carbon = {}; }
    \\if(!globalThis.carbon.on){
    \\  globalThis.carbon.on = function(name, cb){
    \\    (globalThis.__carbon_event_listeners[name] || (globalThis.__carbon_event_listeners[name] = [])).push(cb);
    \\  };
    \\}
    \\if(!globalThis.carbon.off){
    \\  globalThis.carbon.off = function(name, cb){
    \\    var arr = globalThis.__carbon_event_listeners[name];
    \\    if (!arr) return;
    \\    var idx = arr.indexOf(cb);
    \\    if (idx !== -1) arr.splice(idx, 1);
    \\  };
    \\}
    \\if(!globalThis.__carbon_on_event){
    \\  globalThis.__carbon_on_event = function(name, payloadJson){
    \\    var payload = null;
    \\    try { payload = JSON.parse(payloadJson); } catch(e) {}
    \\    var arr = globalThis.__carbon_event_listeners[name];
    \\    if (!arr) return;
    \\    for (var i = 0; i < arr.length; i++) {
    \\      try { arr[i](payload); } catch(e) {}
    \\    }
    \\  };
    \\}
    \\if(!globalThis.__carbon_on_binary_event){
    \\  globalThis.__carbon_on_binary_event = function(name, data){
    \\    var arr = globalThis.__carbon_event_listeners[name];
    \\    if (!arr) return;
    \\    for (var i = 0; i < arr.length; i++) {
    \\      try { arr[i](data); } catch(e) {}
    \\    }
    \\  };
    \\}
;

pub fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    g_app = app;
    _ = app.eval(EVENT_SHIM);
    installGlobals(app);
}
comptime {
    sdk.ext.implement("lifecycle.register", carbon_plugin_register);
}

pub fn carbon_plugin_after_reload(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    g_app = app;
    _ = app.eval(EVENT_SHIM);
    installGlobals(app);
}
comptime {
    sdk.ext.implement("lifecycle.after_reload", carbon_plugin_after_reload);
}

fn installGlobals(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("getVolume", jsGetVolume);
    _ = app.setGlobalFunction("setVolume", jsSetVolume);
    _ = app.setGlobalFunction("getMuted", jsGetMuted);
    _ = app.setGlobalFunction("setMuted", jsSetMuted);
    _ = app.setGlobalFunction("listenMediaKeys", jsListenMediaKeys);
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}
fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    writeResult(buf, cap, if (v) "true" else "false");
}

fn parseArgs(args_json: [*c]const u8, allocator: std.mem.Allocator) []const std.json.Value {
    if (args_json == null) return &.{};
    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch return &.{};
    return switch (parsed.value) {
        .array => |a| a.items,
        else => &.{},
    };
}

fn numAt(args: []const std.json.Value, idx: usize) ?f32 {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .integer => |i| @floatFromInt(i),
        .float => |f| @floatCast(f),
        else => null,
    };
}

fn boolAt(args: []const std.json.Value, idx: usize) ?bool {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .bool => |b| b,
        else => null,
    };
}

// ── getVolume() → number | null ─────────────────────────────────────────

fn jsGetVolume(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var level: f32 = 0;
    if (app.mediaGetVolume(&level) != sdk.CARBON_OK) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    var buf: [32]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "{d}", .{level}) catch {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    writeResult(result_buf, result_buf_len, s);
}

// ── setVolume(level) → boolean ───────────────────────────────────────────

fn jsSetVolume(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    const ok = blk: {
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const args = parseArgs(args_json, arena.allocator());
        const level = numAt(args, 0) orelse break :blk false;
        break :blk app.mediaSetVolume(level) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── getMuted() → boolean | null ──────────────────────────────────────────

fn jsGetMuted(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var muted: i32 = 0;
    if (app.mediaGetMute(&muted) != sdk.CARBON_OK) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    writeBoolResult(result_buf, result_buf_len, muted != 0);
}

// ── setMuted(muted) → boolean ─────────────────────────────────────────────

fn jsSetMuted(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    const ok = blk: {
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const args = parseArgs(args_json, arena.allocator());
        const muted = boolAt(args, 0) orelse break :blk false;
        break :blk app.mediaSetMute(if (muted) 1 else 0) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── listenMediaKeys() → boolean ───────────────────────────────────────────

fn jsListenMediaKeys(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.mediaListenKeys() == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"media\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
