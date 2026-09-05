// dialog — the OS's own file pickers and message boxes.
//
// Moves dialogs out of carbon-mini's always-on ambient `__cm_dialog_*`
// globals and into an explicit, opt-in plugin:
//
//   carbon plugin add dialog
//
//   import { openFile, saveFileText, confirm } from "@carbon/plugins/dialog";
//   const path = openFile({ filters: [{ name: "Images", extensions: ["png"] }] });
//
// `openFileText`/`saveFileText` do the picker AND the read/write in one
// call — the only way to read/write a file the user picked from outside
// the app's own sandboxed directories without a raw filesystem path ever
// reaching JS (see solutions/infrastructure/plugin-host/native/dialog.rs).
//
// KNOWN LIMIT: a JS-callable plugin function's result crosses back through
// a fixed 4096-byte buffer (see clipboard's main.zig doc comment). A file
// read via `openFileText` larger than that silently returns `undefined`.
//
//   zig build                build it
//   carbon plugin add dialog fetch + build + install into the current app
//   carbon plugin check      verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "dialog",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:dialog"},
    .exports = &.{
        .{ .name = "openFile" },
        .{ .name = "openFiles" },
        .{ .name = "openDir" },
        .{ .name = "saveFile" },
        .{ .name = "openFileText" },
        .{ .name = "saveFileText" },
        .{ .name = "message" },
        .{ .name = "confirm" },
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

// ── lifecycle.register / lifecycle.after_reload ─────────────────────────────
//
// `pub`, not a bare `fn`: see sdk.ext.implement's doc comment — a static
// release build's generated umbrella reaches these through `@import`, which
// only works for `pub` declarations.

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
    _ = app.setGlobalFunction("openFile", jsOpenFile);
    _ = app.setGlobalFunction("openFiles", jsOpenFiles);
    _ = app.setGlobalFunction("openDir", jsOpenDir);
    _ = app.setGlobalFunction("saveFile", jsSaveFile);
    _ = app.setGlobalFunction("openFileText", jsOpenFileText);
    _ = app.setGlobalFunction("saveFileText", jsSaveFileText);
    _ = app.setGlobalFunction("message", jsMessage);
    _ = app.setGlobalFunction("confirm", jsConfirm);
}

// ── Result / arg-parsing helpers ─────────────────────────────────────────

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    writeResult(buf, cap, if (v) "true" else "false");
}

fn writeStringResult(buf: [*c]u8, cap: usize, s: []const u8) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const gpa = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    if (quoteInto(gpa, &out, s)) {
        writeResult(buf, cap, out.items);
    } else {
        writeResult(buf, cap, "null");
    }
}

fn quoteInto(gpa: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8) bool {
    out.append(gpa, '"') catch return false;
    for (s) |c| {
        switch (c) {
            '"' => out.appendSlice(gpa, "\\\"") catch return false,
            '\\' => out.appendSlice(gpa, "\\\\") catch return false,
            '\n' => out.appendSlice(gpa, "\\n") catch return false,
            '\r' => out.appendSlice(gpa, "\\r") catch return false,
            '\t' => out.appendSlice(gpa, "\\t") catch return false,
            0x00...0x08, 0x0b...0x0c, 0x0e...0x1f => {
                var tmp: [6]u8 = undefined;
                const written = std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}) catch return false;
                out.appendSlice(gpa, written) catch return false;
            },
            else => out.append(gpa, c) catch return false,
        }
    }
    out.append(gpa, '"') catch return false;
    return true;
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

fn argString(args: []const std.json.Value, idx: usize) ?[]const u8 {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .string => |s| s,
        else => null,
    };
}

/// Re-serializes `args[idx]` (the JS-side options object, if any) back into
/// a compact JSON string for the `opts_json` ABI parameter — `"{}"` if
/// absent, matching the Rust side's `OpenOpts::default()` fallback.
fn optsJsonAt(allocator: std.mem.Allocator, args: []const std.json.Value, idx: usize) [:0]const u8 {
    if (idx >= args.len) return "{}";
    const s = std.json.Stringify.valueAlloc(allocator, args[idx], .{}) catch return "{}";
    return allocator.dupeZ(u8, s) catch "{}";
}

// ── openFile(opts?) / openDir(opts?) / saveFile(opts?) → string | null ────

fn openLikeCall(
    call: *const fn (app: sdk.CarbonApp, opts_json: [*:0]const u8, out_status: *i32) [*c]u8,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const args = parseArgs(args_json, allocator);
    const opts_z = optsJsonAt(allocator, args, 0);
    var status: i32 = sdk.CARBON_OK;
    const ptr = call(app, opts_z.ptr, &status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    writeStringResult(result_buf, result_buf_len, std.mem.span(ptr));
}

fn jsOpenFile(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    openLikeCall(sdk.CarbonApp.dialogOpenFile, args_json, result_buf, result_buf_len);
}

fn jsOpenDir(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    openLikeCall(sdk.CarbonApp.dialogOpenDir, args_json, result_buf, result_buf_len);
}

fn jsSaveFile(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    openLikeCall(sdk.CarbonApp.dialogSaveFile, args_json, result_buf, result_buf_len);
}

fn jsOpenFileText(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    openLikeCall(sdk.CarbonApp.dialogOpenFileText, args_json, result_buf, result_buf_len);
}

// ── openFiles(opts?) → string[] ─────────────────────────────────────────────
// dialog_open_files already returns a JSON array string from the host side
// — passed through as-is, not re-quoted as a JSON string.

fn jsOpenFiles(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "[]");
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const args = parseArgs(args_json, allocator);
    const opts_z = optsJsonAt(allocator, args, 0);
    var status: i32 = sdk.CARBON_OK;
    const ptr = app.dialogOpenFiles(opts_z.ptr, &status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "[]");
        return;
    }
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── saveFileText(content, opts?) → boolean ──────────────────────────────────

fn jsSaveFileText(
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
        const content = argString(args, 0) orelse break :blk false;
        const opts_z = optsJsonAt(allocator, args, 1);
        const content_z = allocator.dupeZ(u8, content) catch break :blk false;
        break :blk app.dialogSaveFileText(opts_z.ptr, content_z.ptr) == 1;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── message(title, body, level?) → undefined ────────────────────────────────

fn jsMessage(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    _ = result_buf;
    _ = result_buf_len;
    const app = g_app orelse return;
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const args = parseArgs(args_json, allocator);
    const title = argString(args, 0) orelse return;
    const body = argString(args, 1) orelse return;
    const level = argString(args, 2) orelse "info";
    const title_z = allocator.dupeZ(u8, title) catch return;
    const body_z = allocator.dupeZ(u8, body) catch return;
    const level_z = allocator.dupeZ(u8, level) catch return;
    _ = app.dialogMessage(title_z.ptr, body_z.ptr, level_z.ptr);
}

// ── confirm(title, body) → boolean ──────────────────────────────────────────

fn jsConfirm(
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
        const title = argString(args, 0) orelse break :blk false;
        const body = argString(args, 1) orelse break :blk false;
        const title_z = allocator.dupeZ(u8, title) catch break :blk false;
        const body_z = allocator.dupeZ(u8, body) catch break :blk false;
        break :blk app.dialogConfirm(title_z.ptr, body_z.ptr) == 1;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"dialog\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}

test "optsJsonAt defaults to an empty object when the arg is missing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const got = optsJsonAt(arena.allocator(), &.{}, 0);
    try std.testing.expectEqualStrings("{}", got);
}
