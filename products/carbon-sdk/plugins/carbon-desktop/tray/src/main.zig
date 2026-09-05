// tray — a system tray icon, with an optional context menu.
//
//   carbon plugin add tray
//
//   import { useTray } from "@carbon/plugins/tray";
//   useTray({
//     icon: "assets/tray.png",
//     tooltip: "My App",
//     menu: [{ id: "quit", label: "Quit" }],
//   }, {
//     onClick: () => console.log("clicked"),
//     onMenuSelect: (id) => console.log("menu:", id),
//   });
//
// One tray icon per process — a second `setup()` call is a no-op (see
// solutions/infrastructure/plugin-host/native/tray.rs). Icon must be a
// PNG file; decoded to raw RGBA on the host side rather than trusting
// each platform's native icon-loading (Windows specifically requires a
// real `.ico` file for that path — PNG-via-RGBA is the one contract that
// works identically everywhere).
//
// Event delivery reuses the push_event + JS-shim pattern from
// labs/examples/pulse/carbon/plugins/local/carbon-hotkey, generalized the same way
// global-shortcuts' shim is (adds `carbon.off`).
//
//   zig build              build it
//   carbon plugin add tray fetch + build + install into the current app
//   carbon plugin check    verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "tray",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:tray"},
    .exports = &.{.{ .name = "setup" }},
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
// plugin installing it is a no-op).
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

// ── lifecycle.register / lifecycle.after_reload ─────────────────────────────
//
// `pub`, not a bare `fn`: see sdk.ext.implement's doc comment — a static
// release build's generated umbrella reaches these through `@import`, which
// only works for `pub` declarations.

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
    _ = app.setGlobalFunction("setup", jsSetup);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

/// Joins `raw` onto the app's project_dir unless it's already absolute,
/// normalizing every '/' to the platform separator — see fonts'
/// `resolvePath` (identical logic, duplicated rather than shared since
/// each carbon-sdk plugin is an independently built/distributed package).
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

// ── setup({ icon, tooltip?, menu? }) → boolean ──────────────────────────────

fn jsSetup(
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
        if (args.len == 0) break :blk false;
        const opts = switch (args[0]) {
            .object => |o| o,
            else => break :blk false,
        };

        const icon_raw = switch (opts.get("icon") orelse break :blk false) {
            .string => |s| s,
            else => break :blk false,
        };
        const icon_z = resolvePath(allocator, app, icon_raw) catch break :blk false;

        const tooltip: []const u8 = if (opts.get("tooltip")) |v| switch (v) {
            .string => |s| s,
            else => "",
        } else "";
        const tooltip_z = allocator.dupeZ(u8, tooltip) catch break :blk false;

        const menu_json: []const u8 = if (opts.get("menu")) |v|
            (std.json.Stringify.valueAlloc(allocator, v, .{}) catch "[]")
        else
            "[]";
        const menu_z = allocator.dupeZ(u8, menu_json) catch break :blk false;

        break :blk app.traySetup(icon_z.ptr, tooltip_z.ptr, menu_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"tray\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}

test "resolvePath joins a relative path onto project_dir, all separators normalized" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // "\\?\C:\..." — the real shape Win32 hands plugins for project_dir
    // (see fonts' identical test) — already sep-correct on Windows, and a
    // fine (if odd-looking) absolute path on POSIX, either way exercising
    // "every '/' in the RESULT becomes sep", not just the join point.
    var raw_app: sdk.RawApp = std.mem.zeroes(sdk.RawApp);
    raw_app.project_dir = "\\\\?\\C:\\Users\\dev\\my-app";
    const app = sdk.CarbonApp.fromRaw(&raw_app);
    const got = try resolvePath(arena.allocator(), app, "assets/tray.png");
    const want = "\\\\?\\C:\\Users\\dev\\my-app" ++ [1]u8{std.fs.path.sep} ++ "assets" ++ [1]u8{std.fs.path.sep} ++ "tray.png";
    try std.testing.expectEqualStrings(want, got);
}
