// sqlite — embedded SQLite storage, via the host's bundled rusqlite (no
// system sqlite3.dll dependency; see the host-side sqlite.rs header for
// why). NOT enabled by default in the plugin-host binary today — unlike
// every other carbon-sdk plugin, `sqlite` was deliberately left out of
// carbon-plugin-host's default Cargo features (it's real compiled-C
// weight, ~1 MiB+) pending the "build only what a manifest declares"
// wiring noted in that crate's own Cargo.toml. Until that lands,
// `sqlite_exec` returns CARBON_ERR_GENERIC against a runtime that wasn't
// itself built with `--features sqlite` — installing this plugin alone is
// not sufficient yet. Real, not a stub: the Rust implementation is
// complete and tested, this is a build-wiring gap, not a missing feature.
//
//   carbon plugin add sqlite
//
//   import { exec } from "carbon:sqlite";
//   exec("app.db", "INSERT INTO notes (text) VALUES (?1)", ["hello"]);
//   const rows = exec("app.db", "SELECT * FROM notes");
//
// `db_path` is resolved relative to the app's project_dir when not already
// absolute, same convention as fonts'/tray's own resolvePath. A SELECT
// returns an array of row objects; an INSERT/UPDATE/DELETE returns
// `{changes, lastInsertRowid}`. `params` (optional): null/boolean/number/
// string values only — no blob params yet (see carbon_plugin.h's
// sqlite_exec doc comment for the full scope note). Connections are opened
// lazily and kept for the process lifetime; there is no explicit close.
//
//   zig build                build it
//   carbon plugin add sqlite fetch + build + install into the current app
//   carbon plugin check      verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "sqlite",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:sqlite"},
    .exports = &.{.{ .name = "exec" }},
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
    _ = app.setGlobalFunction("exec", jsExec);
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
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

// ── exec(dbPath, sql, params?) → row[] | {changes, lastInsertRowid} ────────

fn jsExec(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    if (args_json == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    const args = switch (parsed.value) {
        .array => |a| a.items,
        else => {
            writeResult(result_buf, result_buf_len, "null");
            return;
        },
    };
    if (args.len < 2) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    const db_path_raw = switch (args[0]) {
        .string => |s| s,
        else => {
            writeResult(result_buf, result_buf_len, "null");
            return;
        },
    };
    const sql = switch (args[1]) {
        .string => |s| s,
        else => {
            writeResult(result_buf, result_buf_len, "null");
            return;
        },
    };
    const db_path_z = resolvePath(allocator, app, db_path_raw) catch {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    const sql_z = allocator.dupeZ(u8, sql) catch {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    // params (args[2]) is re-serialized as-is — it's already the JSON
    // array shape sqlite_exec's params_json parameter expects.
    const params_z: [:0]const u8 = if (args.len > 2) blk: {
        const s = std.json.Stringify.valueAlloc(allocator, args[2], .{}) catch break :blk "";
        break :blk allocator.dupeZ(u8, s) catch "";
    } else "";

    var status: i32 = sdk.CARBON_OK;
    const ptr = app.sqliteExec(db_path_z.ptr, sql_z.ptr, params_z.ptr, &status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    // Already a JSON string from the host side — passed through as-is,
    // not re-quoted, same convention as dialog's openFiles.
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"sqlite\"") != null);
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

    const got = try resolvePath(arena.allocator(), app, "data/app.db");
    const want = "\\\\?\\C:\\Users\\dev\\my-app" ++ [1]u8{std.fs.path.sep} ++ "data" ++ [1]u8{std.fs.path.sep} ++ "app.db";
    try std.testing.expectEqualStrings(want, got);
}
