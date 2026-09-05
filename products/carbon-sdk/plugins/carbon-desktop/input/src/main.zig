// input — modifier/lock-key state, synthetic keyboard/mouse input, and
// active keyboard-layout detection (Windows only for now; see the input_*
// fields' own doc comment in carbon_plugin.h and the host-side input.rs
// header for the full scope note — multi-touch, Force Touch, pen/stylus,
// and on-screen keyboard control are NOT covered here).
//
//   carbon plugin add input
//
//   import { getModifierState, sendKey, moveMouse, clickMouse, getKeyboardLayout } from "@carbon/plugins/input";
//   const { shift, ctrl, alt, capsLock, numLock } = getModifierState();
//   sendKey(0x41, true);  sendKey(0x41, false); // "A" down, up
//   moveMouse(32768, 32768); // screen-absolute, 0..=65535
//   clickMouse(0, true); clickMouse(0, false);  // left button down, up
//   const layout = getKeyboardLayout(); // e.g. "00000409"
//
//   zig build              build it
//   carbon plugin add input fetch + build + install into the current app
//   carbon plugin check    verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "input",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:input"},
    .exports = &.{
        .{ .name = "getModifierState" },
        .{ .name = "sendKey" },
        .{ .name = "moveMouse" },
        .{ .name = "clickMouse" },
        .{ .name = "getKeyboardLayout" },
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

pub fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    g_app = app;
    installGlobals(app);
}
comptime {
    sdk.ext.implement("lifecycle.register", carbon_plugin_register);
}

pub fn carbon_plugin_after_reload(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    g_app = app;
    installGlobals(app);
}
comptime {
    sdk.ext.implement("lifecycle.after_reload", carbon_plugin_after_reload);
}

fn installGlobals(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("getModifierState", jsGetModifierState);
    _ = app.setGlobalFunction("sendKey", jsSendKey);
    _ = app.setGlobalFunction("moveMouse", jsMoveMouse);
    _ = app.setGlobalFunction("clickMouse", jsClickMouse);
    _ = app.setGlobalFunction("getKeyboardLayout", jsGetKeyboardLayout);
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

fn intAt(args: []const std.json.Value, idx: usize) ?i64 {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
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

// ── getModifierState() → {shift, ctrl, alt, capsLock, numLock} | null ──────

fn jsGetModifierState(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var status: i32 = sdk.CARBON_OK;
    const ptr = app.inputModifierState(&status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    // Already a JSON object from the host side — passed through as-is,
    // same convention as theme's queryThemePrefs.
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── sendKey(vk, keyDown) → boolean ──────────────────────────────────────────

fn jsSendKey(
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
        const vk = intAt(args, 0) orelse break :blk false;
        const key_down = boolAt(args, 1) orelse break :blk false;
        break :blk app.inputSendKey(@intCast(vk), if (key_down) 1 else 0) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── moveMouse(x, y) → boolean ───────────────────────────────────────────────

fn jsMoveMouse(
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
        const x = intAt(args, 0) orelse break :blk false;
        const y = intAt(args, 1) orelse break :blk false;
        break :blk app.inputMoveMouse(@intCast(x), @intCast(y)) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── clickMouse(button, isDown) → boolean ────────────────────────────────────
// button: 0 = left, 1 = right, 2 = middle.

fn jsClickMouse(
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
        const button = intAt(args, 0) orelse break :blk false;
        const is_down = boolAt(args, 1) orelse break :blk false;
        break :blk app.inputClickMouse(@intCast(button), if (is_down) 1 else 0) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── getKeyboardLayout() → string | null ─────────────────────────────────────

fn jsGetKeyboardLayout(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var status: i32 = sdk.CARBON_OK;
    const ptr = app.inputKeyboardLayout(&status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    // Already a JSON string (quoted) from the host side.
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"input\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
