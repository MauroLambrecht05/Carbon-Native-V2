// clipboard — the system clipboard, text only.
//
// Moves clipboard access out of carbon-mini's always-on ambient
// `__cm_clipboard_*` globals and into an explicit, opt-in plugin:
//
//   carbon plugin add clipboard
//
//   import { readText, writeText, clear } from "@carbon/plugins/clipboard";
//
// KNOWN LIMIT: a JS-callable plugin function's result crosses back through
// a fixed 4096-byte buffer (`CarbonJSCallback`'s `result_buf` — see
// carbon_plugin.h and host_exports.rs's `carbon_callback_trampoline`). A
// clipboard read larger than that silently returns `undefined` rather than
// truncating — a pre-existing ceiling of the callback ABI itself (nothing
// before this plugin ever returned enough data to hit it), not something
// specific to clipboard text. Most clipboard content is well under this.
//
//   zig build                    build it
//   carbon plugin add clipboard  fetch + build + install into the current app
//   carbon plugin check          verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "clipboard",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:clipboard"},
    .exports = &.{ .{ .name = "readText" }, .{ .name = "writeText" }, .{ .name = "clear" } },
    // Config's own default (ext.REGISTRY_MINOR) tracks the extension-point
    // registry's highest `since_minor`, NOT carbon_plugin.h's CarbonApp
    // struct ABI — a different axis that happened to read "1" here despite
    // this plugin genuinely needing ABI 1.3 (clipboard_read_text etc.).
    // sdk.ABI_VERSION_MAJOR/MINOR are the real header-derived constants.
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
// Both install the same three globals. HMR re-evaluates the JS bundle in
// the same context; per carbon_plugin.h, globals installed in
// carbon_plugin_register are gone afterward and must be re-installed here.
//
// `pub`, not a bare `fn`: in a dynamic build `sdk.ext.implement` exports this
// under the registry symbol and `pub` is redundant; in a static release
// build nothing exports it at all and `pub` is the ONLY way the generated
// umbrella (which `@import`s this file as a module) can reach it. See
// `sdk.ext.implement`'s doc comment.

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
    _ = app.setGlobalFunction("readText", jsReadText);
    _ = app.setGlobalFunction("writeText", jsWriteText);
    _ = app.setGlobalFunction("clear", jsClear);
}

// ── Result helpers ────────────────────────────────────────────────────────

/// Write a JSON result into the host's buffer, NUL-terminated. On overflow
/// it writes nothing, matching a missing result — the JS side sees
/// `undefined`, not a truncated/invalid value.
fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    writeResult(buf, cap, if (v) "true" else "false");
}

/// JSON-quote `s` (proper escaping via an arena) and write it as the
/// result. Falls back to `null` if quoting fails for any reason.
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

// ── readText() → string | null ──────────────────────────────────────────────

fn jsReadText(
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
    const ptr = app.clipboardReadText(&status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    writeStringResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── writeText(text) → boolean ────────────────────────────────────────────────

fn jsWriteText(
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
        if (args.len == 0) break :blk false;
        const text = switch (args[0]) {
            .string => |s| s,
            else => break :blk false,
        };
        const text_z = allocator.dupeZ(u8, text) catch break :blk false;
        break :blk app.clipboardWriteText(text_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── clear() → boolean ─────────────────────────────────────────────────────

fn jsClear(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.clipboardClear() == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "toToml produces a non-empty manifest" {
    const generated = comptime sdk.manifest.toToml(CFG);
    try std.testing.expect(generated.len > 0);
}

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"clipboard\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}

test "quoteInto escapes quotes, backslashes and control chars" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try std.testing.expect(quoteInto(gpa, &out, "he said \"hi\"\n"));
    try std.testing.expectEqualStrings("\"he said \\\"hi\\\"\\n\"", out.items);
}
