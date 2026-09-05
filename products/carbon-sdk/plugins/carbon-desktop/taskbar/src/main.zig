// taskbar — a badge and progress overlay on the app's taskbar button
// (Windows only; see taskbar_set_progress/taskbar_set_badge's own doc
// comment in carbon_plugin.h and the host-side taskbar.rs header for why
// macOS/Linux aren't stubbed out here rather than guessed at).
//
//   carbon plugin add taskbar
//
//   import { setProgress, setBadge, clearBadge, clearProgress } from "@carbon/plugins/taskbar";
//   setProgress(3, 10);           // 30% progress overlay
//   setBadge("assets/badge.png"); // a pre-rendered PNG overlay icon
//
// BADGE: there is no native Windows numeric badge — `setBadge` sets an
// OVERLAY ICON (a small icon composited onto the taskbar button), the
// accepted equivalent. The app supplies its own pre-rendered image (e.g.
// a numbered circle) rather than this plugin rendering text into one
// itself — v1 scope, see main design note in taskbar.rs.
//
// No event delivery here — unlike tray/menu, there's nothing for JS to
// listen for (a progress/badge overlay has no click of its own); this
// plugin is purely two setters, same "call it, get a boolean back" shape
// as fonts' loadFont.
//
//   zig build                 build it
//   carbon plugin add taskbar fetch + build + install into the current app
//   carbon plugin check       verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "taskbar",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:taskbar"},
    .exports = &.{
        .{ .name = "setProgress" },
        .{ .name = "clearProgress" },
        .{ .name = "setBadge" },
        .{ .name = "clearBadge" },
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
    _ = app.setGlobalFunction("setProgress", jsSetProgress);
    _ = app.setGlobalFunction("clearProgress", jsClearProgress);
    _ = app.setGlobalFunction("setBadge", jsSetBadge);
    _ = app.setGlobalFunction("clearBadge", jsClearBadge);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
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

fn numAt(args: []const std.json.Value, idx: usize) ?u64 {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .integer => |i| if (i < 0) null else @intCast(i),
        .float => |f| if (f < 0) null else @intFromFloat(f),
        else => null,
    };
}

fn strAt(args: []const std.json.Value, idx: usize) ?[]const u8 {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .string => |s| s,
        else => null,
    };
}

/// Joins `raw` onto the app's project_dir unless it's already absolute —
/// see fonts'/tray's identical helper; duplicated rather than shared since
/// each carbon-sdk plugin is an independently built/distributed package.
fn resolvePath(allocator: std.mem.Allocator, app: sdk.CarbonApp, raw: []const u8) ![:0]const u8 {
    if (raw.len == 0) return error.EmptyPath;
    const is_abs = raw[0] == '/' or raw[0] == '\\' or (raw.len > 1 and raw[1] == ':');
    const joined = if (is_abs)
        try allocator.dupeZ(u8, raw)
    else blk: {
        const project_dir = std.mem.span(app.raw.project_dir);
        break :blk try std.fmt.allocPrintSentinel(allocator, "{s}{c}{s}", .{ project_dir, std.fs.path.sep, raw }, 0);
    };
    if (std.fs.path.sep != '/') {
        for (joined) |*ch| {
            if (ch.* == '/') ch.* = std.fs.path.sep;
        }
    }
    return joined;
}

// ── setProgress(completed, total) → boolean ─────────────────────────────

fn jsSetProgress(
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
        const completed = numAt(args, 0) orelse break :blk false;
        const total = numAt(args, 1) orelse break :blk false;
        break :blk app.taskbarSetProgress(completed, total) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── clearProgress() → boolean ────────────────────────────────────────────

fn jsClearProgress(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.taskbarSetProgress(0, 0) == sdk.CARBON_OK);
}

// ── setBadge(iconPath, description?) → boolean ──────────────────────────

fn jsSetBadge(
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
        const allocator = arena.allocator();
        const args = parseArgs(args_json, allocator);
        const icon_raw = strAt(args, 0) orelse break :blk false;
        const icon_z = resolvePath(allocator, app, icon_raw) catch break :blk false;
        const description = strAt(args, 1) orelse "";
        const description_z = allocator.dupeZ(u8, description) catch break :blk false;
        break :blk app.taskbarSetBadge(icon_z.ptr, description_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── clearBadge() → boolean ───────────────────────────────────────────────

fn jsClearBadge(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.taskbarSetBadge("", "") == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"taskbar\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}

test "resolvePath joins a relative path onto project_dir, all separators normalized" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var raw_app: sdk.RawApp = std.mem.zeroes(sdk.RawApp);
    raw_app.project_dir = "\\\\?\\C:\\Users\\dev\\my-app";
    const app = sdk.CarbonApp.fromRaw(&raw_app);

    const got = try resolvePath(arena.allocator(), app, "assets/badge.png");
    const want = "\\\\?\\C:\\Users\\dev\\my-app" ++ [1]u8{std.fs.path.sep} ++ "assets" ++ [1]u8{std.fs.path.sep} ++ "badge.png";
    try std.testing.expectEqualStrings(want, got);
}
