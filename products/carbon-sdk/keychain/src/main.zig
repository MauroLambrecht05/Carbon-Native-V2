// keychain — the OS credential store, keyed by (service, account).
//
// Moves keychain access out of carbon-mini's always-on ambient
// `__cm_keychain_*` globals and into an explicit, opt-in plugin:
//
//   carbon plugin add keychain
//
//   import { set, get, delete } from "@carbon/plugins/keychain";
//   set("my-app", "openai-api-key", token);
//   const token = get("my-app", "openai-api-key"); // null if not stored
//
// KNOWN LIMIT: a JS-callable plugin function's result crosses back through
// a fixed 4096-byte buffer (see clipboard's main.zig doc comment for the
// full explanation). A password/token larger than that silently returns
// `undefined` rather than truncating.
//
//   zig build                   build it
//   carbon plugin add keychain  fetch + build + install into the current app
//   carbon plugin check         verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "keychain",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:keychain"},
    // "remove", not "delete" — delete is a reserved word and can't be a
    // function declaration name (see @carbon/vite/imports' codegen:
    // `export function ${name}(...)`). The underlying global this plugin
    // installs is still literally "delete" (see installGlobals below).
    .exports = &.{
        .{ .name = "set" },
        .{ .name = "get" },
        .{ .name = "remove", .global = "delete" },
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
    _ = app.setGlobalFunction("set", jsSet);
    _ = app.setGlobalFunction("get", jsGet);
    _ = app.setGlobalFunction("delete", jsDelete);
}

// ── Result helpers ────────────────────────────────────────────────────────

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

/// Parses `args_json` as a 2-element string array `[service, account]`. On
/// success, calls `withArgs(allocator, service_z, account_z)` and returns
/// its result; on any parse failure, returns `null`.
fn parseTwoStrings(
    args_json: [*c]const u8,
    allocator: std.mem.Allocator,
) ?struct { service: [:0]const u8, account: [:0]const u8 } {
    if (args_json == null) return null;
    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch return null;
    const args = switch (parsed.value) {
        .array => |a| a.items,
        else => return null,
    };
    if (args.len < 2) return null;
    const service = switch (args[0]) {
        .string => |s| s,
        else => return null,
    };
    const account = switch (args[1]) {
        .string => |s| s,
        else => return null,
    };
    const service_z = allocator.dupeZ(u8, service) catch return null;
    const account_z = allocator.dupeZ(u8, account) catch return null;
    return .{ .service = service_z, .account = account_z };
}

// ── set(service, account, password) → boolean ───────────────────────────────

fn jsSet(
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
        if (args_json == null) break :blk false;
        const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
        const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch break :blk false;
        const args = switch (parsed.value) {
            .array => |a| a.items,
            else => break :blk false,
        };
        if (args.len < 3) break :blk false;
        const service = switch (args[0]) {
            .string => |s| s,
            else => break :blk false,
        };
        const account = switch (args[1]) {
            .string => |s| s,
            else => break :blk false,
        };
        const password = switch (args[2]) {
            .string => |s| s,
            else => break :blk false,
        };
        const service_z = allocator.dupeZ(u8, service) catch break :blk false;
        const account_z = allocator.dupeZ(u8, account) catch break :blk false;
        const password_z = allocator.dupeZ(u8, password) catch break :blk false;
        break :blk app.keychainSet(service_z.ptr, account_z.ptr, password_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── get(service, account) → string | null ───────────────────────────────────

fn jsGet(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const args = parseTwoStrings(args_json, arena.allocator()) orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var status: i32 = sdk.CARBON_OK;
    const ptr = app.keychainGet(args.service.ptr, args.account.ptr, &status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    writeStringResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── delete(service, account) → boolean ──────────────────────────────────────

fn jsDelete(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const args = parseTwoStrings(args_json, arena.allocator()) orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.keychainDelete(args.service.ptr, args.account.ptr) == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"keychain\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
