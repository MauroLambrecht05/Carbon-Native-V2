// logging — structured native logs written to a file, JSONL format, with
// size-based rotation (one `.1` backup, not a numbered chain).
//
//   carbon plugin add logging
//
//   import { log } from "carbon:logging";
//   log("logs/app.log", "info", "started");
//
// `path` is resolved relative to the app's project_dir when not already
// absolute, same convention as fonts'/tray's own resolvePath. The file is
// opened lazily and kept open for the process lifetime — no explicit
// close, no separate "init" call; every `log()` call names its own path.
//
//   zig build                 build it
//   carbon plugin add logging fetch + build + install into the current app
//   carbon plugin check       verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "logging",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:logging"},
    .exports = &.{.{ .name = "log" }},
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
    _ = app.setGlobalFunction("log", jsLog);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
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

// ── log(path, level, message) → boolean ─────────────────────────────────

fn jsLog(
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
        if (args_json == null) break :blk false;
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const allocator = arena.allocator();

        const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
        const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch break :blk false;
        const args = switch (parsed.value) {
            .array => |a| a.items,
            else => break :blk false,
        };
        if (args.len < 3) break :blk false;
        const path_raw = switch (args[0]) {
            .string => |s| s,
            else => break :blk false,
        };
        const level = switch (args[1]) {
            .string => |s| s,
            else => break :blk false,
        };
        const message = switch (args[2]) {
            .string => |s| s,
            else => break :blk false,
        };
        const path_z = resolvePath(allocator, app, path_raw) catch break :blk false;
        const level_z = allocator.dupeZ(u8, level) catch break :blk false;
        const message_z = allocator.dupeZ(u8, message) catch break :blk false;
        break :blk app.logWrite(path_z.ptr, level_z.ptr, message_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"logging\"") != null);
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

    const got = try resolvePath(arena.allocator(), app, "logs/app.log");
    const want = "\\\\?\\C:\\Users\\dev\\my-app" ++ [1]u8{std.fs.path.sep} ++ "logs" ++ [1]u8{std.fs.path.sep} ++ "app.log";
    try std.testing.expectEqualStrings(want, got);
}
