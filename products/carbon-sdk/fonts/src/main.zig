// fonts — loads custom TTF/OTF fonts into the runtime's text engine
// and makes them selectable by name from CSS/JSX font-family, everywhere.
//
// This is what moves font loading out of carbon-mini's own core (which used
// to only auto-discover a single hardcoded <project>/assets/font.ttf,
// anonymous and un-selectable by name) and into an explicit, addressable
// plugin instead:
//
//   carbon plugin add fonts
//
//   loadFont("assets/Poppins-Regular.ttf", "Poppins");
//   loadFont("assets/Poppins-Bold.ttf", "Poppins", 700);
//
// After which `font-family: "Poppins"` — in Tailwind, inline style, or a
// stylesheet — actually selects these exact files (with font-weight:700
// picking the real bold face, not a fallback substitution) instead of being
// reduced to a mono/proportional guess. See
// solutions/capabilities/rendering/text/lib.rs's `font_for_char_named` for
// the selection side of this; this plugin is purely the loading side.
//
//   zig build                 build it
//   carbon plugin add fonts   fetch + build + install into the current app
//   carbon plugin check       verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "fonts",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:fonts"},
    .exports = &.{.{ .name = "loadFont" }},
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

// ── lifecycle.register / lifecycle.after_reload ─────────────────────────────
//
// Both install the same global. HMR re-evaluates the JS bundle in the same
// context; per carbon_plugin.h, globals installed in carbon_plugin_register
// are gone afterward and must be re-installed here — without this,
// `loadFont` would silently disappear after the app's first hot-reload in a
// `carbon dev` session.
//
// `pub`, not a bare `fn`: see sdk.ext.implement's doc comment — a static
// release build's generated umbrella reaches these through `@import`, which
// only works for `pub` declarations.

pub fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    g_app = app;
    installGlobal(app);
}
comptime {
    sdk.ext.implement("lifecycle.register", carbon_plugin_register);
}

pub fn carbon_plugin_after_reload(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    g_app = app;
    installGlobal(app);
}
comptime {
    sdk.ext.implement("lifecycle.after_reload", carbon_plugin_after_reload);
}

fn installGlobal(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("loadFont", jsLoadFont);
}

// ── loadFont(path, family?, weight?) → boolean ──────────────────────────────
//
// `path` is resolved relative to the app's project_dir when not already
// absolute — `loadFont("assets/Poppins.ttf", …)` is what an app writes, not
// a full OS path. `family` (optional) is what CSS/JSX font-family then
// matches against — omit it to load anonymously (coverage-fallback only,
// same as the old assets/font.ttf convenience). `weight` (optional, 1-1000,
// default 400) tags this face on the CSS font-weight scale.
//
// Synchronous by design: the underlying ABI call (app.loadFontPath) already
// is (see carbon_plugin.h's note on load_font_path/load_font_bytes), so
// there is nothing a Promise wrapper would buy here — unlike carbon-clipboard,
// which wraps its sync helpers in Promises purely to match the Web Clipboard
// API's async shape.

fn jsLoadFont(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const ok = doLoad(args_json);
    writeResult(result_buf, result_buf_len, if (ok) "true" else "false");
}

fn doLoad(args_json: [*c]const u8) bool {
    const app = g_app orelse return false;
    if (args_json == null) return false;

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch return false;
    const args = switch (parsed.value) {
        .array => |a| a.items,
        else => return false,
    };
    if (args.len == 0) return false;
    const raw_path = switch (args[0]) {
        .string => |s| s,
        else => return false,
    };

    const path_z = resolvePath(allocator, app, raw_path) catch return false;

    const family_z: ?[:0]const u8 = if (args.len > 1) switch (args[1]) {
        .string => |s| allocator.dupeZ(u8, s) catch null,
        else => null,
    } else null;

    const weight: u32 = if (args.len > 2) switch (args[2]) {
        .integer => |i| @intCast(std.math.clamp(i, 0, 1000)),
        .float => |f| @intFromFloat(std.math.clamp(f, 0.0, 1000.0)),
        else => 0,
    } else 0;

    const family_ptr: ?[*:0]const u8 = if (family_z) |f| f.ptr else null;
    return app.loadFontPath(path_z.ptr, family_ptr, weight) == sdk.CARBON_OK;
}

/// Joins `raw` onto the app's project_dir unless it's already absolute (a
/// leading '/'-or-'\\', or a Windows drive letter like "C:\\...").
///
/// Normalizes every '/' in the RESULT to `std.fs.path.sep`, not just at the
/// join point: on Windows, `project_dir` arrives as a `\\?\C:\...`
/// EXTENDED-LENGTH path (verified against the real value at runtime, not
/// assumed), and that prefix means Win32 passes the remainder to the
/// filesystem nearly verbatim — a literal '/' in it is NOT normalized to
/// '\\' the way an ordinary path's would be. `raw` itself commonly has
/// forward slashes too (`loadFont("assets/Foo.ttf", …)`, the natural way to
/// write it from JS regardless of host OS), so both the join separator AND
/// any slash already inside `raw` have to be fixed, or `\\?\C:\app\assets/
/// Foo.ttf` still silently fails to open as a path.
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

/// Write a JSON result into the host's buffer, NUL-terminated. On overflow
/// (never happens for "true"/"false") it writes nothing, matching a missing
/// result — the JS side sees `undefined`, not a truncated/invalid value.
fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"fonts\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
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

test "resolvePath joins a relative path onto project_dir, all separators normalized" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    // "\\?\C:\..." — the real shape Win32 hands plugins for project_dir
    // (verified against the actual field at runtime, not assumed); on
    // POSIX this is just an ordinary-looking (if odd) absolute path, which
    // is fine — the property under test is "every '/' becomes sep", and
    // that holds either way.
    var raw_app: sdk.RawApp = std.mem.zeroes(sdk.RawApp);
    raw_app.project_dir = "\\\\?\\C:\\Users\\dev\\my-app";
    const app = sdk.CarbonApp.fromRaw(&raw_app);

    const got = try resolvePath(arena.allocator(), app, "assets/Poppins.ttf");
    const want = "\\\\?\\C:\\Users\\dev\\my-app" ++ [1]u8{std.fs.path.sep} ++ "assets" ++ [1]u8{std.fs.path.sep} ++ "Poppins.ttf";
    try std.testing.expectEqualStrings(want, got);
}

test "resolvePath leaves an already-absolute path's structure but still normalizes slashes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var raw_app: sdk.RawApp = std.mem.zeroes(sdk.RawApp);
    raw_app.project_dir = "\\\\?\\C:\\Users\\dev\\my-app";
    const app = sdk.CarbonApp.fromRaw(&raw_app);

    const windows = try resolvePath(arena.allocator(), app, "C:\\Fonts\\custom.ttf");
    try std.testing.expectEqualStrings("C:\\Fonts\\custom.ttf", windows);
}

test "resolvePath rejects an empty path" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var raw_app: sdk.RawApp = std.mem.zeroes(sdk.RawApp);
    raw_app.project_dir = "/home/dev/my-app";
    const app = sdk.CarbonApp.fromRaw(&raw_app);

    try std.testing.expectError(error.EmptyPath, resolvePath(arena.allocator(), app, ""));
}
