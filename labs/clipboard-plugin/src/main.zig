// carbon-clipboard — the reference Carbon plugin.
//
// Small enough to read in one sitting, and it exercises every part of the
// plugin architecture that a real plugin uses:
//
//   * a comptime manifest whose capability list is DERIVED from the extension
//     points it declares
//   * two extension points, one of which is capability-gated
//   * JS globals installed from Rust-free Zig, through the C ABI
//   * an eval'd bootstrap that turns the sync helpers into Promises
//
// ── WHAT USER CODE SEES ─────────────────────────────────────────────────────
//
//     import { read, write } from "carbon:clipboard";
//     await write("hello");
//     const text = await read();   // → "hello"
//
// Both return Promises, matching the Web Clipboard API, so
// `navigator.clipboard.{readText,writeText}` is a near drop-in.
//
// ── PLATFORM SUPPORT ────────────────────────────────────────────────────────
// Windows only, via Win32 `OpenClipboard` / `GetClipboardData`. The previous
// Rust version got macOS and Linux for free from the `arboard` crate; a Zig
// plugin has no equivalent, and writing NSPasteboard and X11 backends by hand
// is a lot of code that teaches nothing about plugins.
//
// On other platforms the two calls reject with "unsupported on this platform",
// which is the honest answer and keeps the example loading everywhere. A real
// clipboard plugin would fill these in.

const std = @import("std");
const builtin = @import("builtin");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────
//
// `clipboard.read` and `clipboard.write` are NOT extension-point capabilities
// — no point in the registry gates on them. They are this plugin's own, for
// what it does beyond plugging in, so they go in `.required` by hand. Compare
// `paint.pixmap`, which a plugin declaring `paint.before` never has to write
// down because the registry knows.
const MANIFEST = sdk.manifest.build(.{
    .name = "carbon-clipboard",
    .version = "0.2.0",
    .points = &.{ "lifecycle.register", "window.theme_changed" },
    .required = &.{ "clipboard.read", "clipboard.write" },
    .modules = &.{"carbon:clipboard"},
});

export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}

// ── lifecycle.register ──────────────────────────────────────────────────────

comptime {
    const point = sdk.ext.expect("lifecycle.register");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_register"));
}

export fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;

    // 1. The sync helpers. The C ABI's callback contract is "args arrive as a
    //    JSON-encoded array, the result is written back as JSON", so both of
    //    these speak JSON at the boundary.
    _ = app.setGlobalFunction("__carbon_clipboard_read", jsRead);
    _ = app.setGlobalFunction("__carbon_clipboard_write", jsWrite);

    // 2. The Promise wrapper. A Promise cannot cross the JSON-string channel,
    //    so the async shape is built in JS around the sync helpers. `eval` is
    //    documented as bootstrap-only in carbon_plugin.h; this is the case it
    //    was meant for.
    _ = app.eval(PROMISE_BOOTSTRAP);
}

// ── window.theme_changed ────────────────────────────────────────────────────
//
// Here to show a second point rather than because a clipboard has a theme:
// it is the smallest possible demonstration that a plugin implements a point
// by exporting a symbol, and that the runtime then calls it.

comptime {
    _ = sdk.ext.expect("window.theme_changed");
}

export fn carbon_ext_window_theme_changed(app_raw: *sdk.RawApp, is_dark: i32) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    _ = app.setGlobalString(
        "__carbon_clipboard_theme",
        if (is_dark != 0) "dark" else "light",
    );
}

// ── The JS callbacks ────────────────────────────────────────────────────────

fn jsRead(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    var buffer: [4096]u8 = undefined;
    var stream = std.io.fixedBufferStream(&buffer);

    if (readClipboard(&buffer)) |text| {
        // A JSON string literal, escaped — clipboard text routinely contains
        // quotes and newlines, and pasting it raw would produce invalid JSON
        // that the runtime reports as an opaque parse failure.
        stream.reset();
        std.json.encodeJsonString(text, .{}, stream.writer()) catch {
            return writeResult(result_buf, result_buf_len, errorJson("clipboard.read: result too large"));
        };
        writeResult(result_buf, result_buf_len, stream.getWritten());
    } else |err| {
        writeResult(result_buf, result_buf_len, errorJson(describe(err)));
    }
}

fn jsWrite(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();

    const text = parseFirstString(arena.allocator(), args_json) catch |err| {
        return writeResult(result_buf, result_buf_len, errorJson(describe(err)));
    };

    if (writeClipboard(text)) {
        // `null` resolves the Promise with undefined.
        writeResult(result_buf, result_buf_len, "null");
    } else |err| {
        writeResult(result_buf, result_buf_len, errorJson(describe(err)));
    }
}

/// Pull the first element of the JSON-encoded argument array as a string.
fn parseFirstString(allocator: std.mem.Allocator, args_json: [*c]const u8) ![]const u8 {
    if (args_json == null) return error.NoArguments;

    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch {
        return error.BadArgumentsJson;
    };

    const array = switch (parsed.value) {
        .array => |a| a,
        else => return error.ArgumentsNotAnArray,
    };
    if (array.items.len == 0) return error.MissingTextArgument;

    return switch (array.items[0]) {
        .string => |s| s,
        else => error.TextArgumentNotAString,
    };
}

/// Write a JSON result into the host's buffer, NUL-terminated.
///
/// On overflow it writes `null` rather than a truncated value: a truncated
/// JSON string is a parse error at the other end, and "the clipboard was
/// empty" is a far less confusing lie than a syntax error.
fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;

    if (json.len + 1 > cap) {
        const sentinel = "null";
        if (cap >= sentinel.len + 1) {
            @memcpy(buf[0..sentinel.len], sentinel);
            buf[sentinel.len] = 0;
        }
        return;
    }
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

/// The `{__carbon_error}` sentinel the Promise wrapper turns into a reject.
///
/// One JSON channel carries both outcomes, so ok and err have to be
/// distinguishable in-band. A sentinel object is the only shape that cannot
/// collide with a legitimate string result.
fn errorJson(message: []const u8) []const u8 {
    // Comptime-known messages only, so this needs no allocation and cannot
    // itself fail while reporting a failure.
    return std.fmt.allocPrint(std.heap.page_allocator, "{{\"__carbon_error\":\"{s}\"}}", .{message}) catch
        "{\"__carbon_error\":\"clipboard failed\"}";
}

fn describe(err: anyerror) []const u8 {
    return switch (err) {
        error.NoArguments => "clipboard.write: no arguments",
        error.BadArgumentsJson => "clipboard.write: arguments were not valid JSON",
        error.ArgumentsNotAnArray => "clipboard.write: expected a JSON array of arguments",
        error.MissingTextArgument => "clipboard.write: missing text argument",
        error.TextArgumentNotAString => "clipboard.write: text argument must be a string",
        error.Unsupported => "clipboard: unsupported on this platform",
        error.Empty => "clipboard.read: the clipboard holds no text",
        else => "clipboard: the OS refused the operation",
    };
}

// ── The OS clipboard ────────────────────────────────────────────────────────

const windows = struct {
    const HANDLE = *anyopaque;
    const CF_UNICODETEXT: c_uint = 13;

    extern "user32" fn OpenClipboard(hWndNewOwner: ?HANDLE) callconv(.c) c_int;
    extern "user32" fn CloseClipboard() callconv(.c) c_int;
    extern "user32" fn EmptyClipboard() callconv(.c) c_int;
    extern "user32" fn GetClipboardData(uFormat: c_uint) callconv(.c) ?HANDLE;
    extern "user32" fn SetClipboardData(uFormat: c_uint, hMem: ?HANDLE) callconv(.c) ?HANDLE;
    extern "kernel32" fn GlobalAlloc(uFlags: c_uint, dwBytes: usize) callconv(.c) ?HANDLE;
    extern "kernel32" fn GlobalLock(hMem: HANDLE) callconv(.c) ?*anyopaque;
    extern "kernel32" fn GlobalUnlock(hMem: HANDLE) callconv(.c) c_int;

    const GMEM_MOVEABLE: c_uint = 0x0002;
};

/// UTF-16 out of the Win32 clipboard, transcoded into `buffer` as UTF-8.
fn readClipboard(buffer: []u8) ![]const u8 {
    if (builtin.os.tag != .windows) return error.Unsupported;

    if (windows.OpenClipboard(null) == 0) return error.OpenFailed;
    defer _ = windows.CloseClipboard();

    const handle = windows.GetClipboardData(windows.CF_UNICODETEXT) orelse return error.Empty;
    const locked = windows.GlobalLock(handle) orelse return error.LockFailed;
    defer _ = windows.GlobalUnlock(handle);

    const wide: [*:0]const u16 = @ptrCast(@alignCast(locked));
    const len = std.mem.len(wide);
    return buffer[0..try std.unicode.utf16LeToUtf8(buffer, wide[0..len])];
}

/// UTF-8 in, UTF-16 onto the Win32 clipboard.
fn writeClipboard(text: []const u8) !void {
    if (builtin.os.tag != .windows) return error.Unsupported;

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const wide = try std.unicode.utf8ToUtf16LeAllocZ(arena.allocator(), text);

    if (windows.OpenClipboard(null) == 0) return error.OpenFailed;
    defer _ = windows.CloseClipboard();
    _ = windows.EmptyClipboard();

    // The clipboard takes OWNERSHIP of this allocation on success, so it must
    // be GlobalAlloc'd and must NOT be freed here. Freeing it is the classic
    // Win32 clipboard double-free.
    const bytes = (wide.len + 1) * @sizeOf(u16);
    const handle = windows.GlobalAlloc(windows.GMEM_MOVEABLE, bytes) orelse return error.OutOfMemory;
    const locked = windows.GlobalLock(handle) orelse return error.LockFailed;
    const dest: [*]u16 = @ptrCast(@alignCast(locked));
    @memcpy(dest[0 .. wide.len + 1], wide[0 .. wide.len + 1]);
    _ = windows.GlobalUnlock(handle);

    if (windows.SetClipboardData(windows.CF_UNICODETEXT, handle) == null) {
        return error.SetFailed;
    }
}

// ── The Promise bootstrap ───────────────────────────────────────────────────

const PROMISE_BOOTSTRAP =
    \\(function() {
    \\  const ERROR_KEY = "__carbon_error";
    \\  const wrap = (syncName) => (...args) => new Promise((resolve, reject) => {
    \\    try {
    \\      const fn = globalThis[syncName];
    \\      if (typeof fn !== "function") {
    \\        reject(new Error("carbon-clipboard not loaded: " + syncName));
    \\        return;
    \\      }
    \\      const result = fn.apply(null, args);
    \\      if (result && typeof result === "object" && ERROR_KEY in result) {
    \\        reject(new Error(String(result[ERROR_KEY])));
    \\        return;
    \\      }
    \\      resolve(result);
    \\    } catch (e) {
    \\      reject(e instanceof Error ? e : new Error(String(e)));
    \\    }
    \\  });
    \\  globalThis.__carbon_clipboard_read_async  = wrap("__carbon_clipboard_read");
    \\  globalThis.__carbon_clipboard_write_async = wrap("__carbon_clipboard_write");
    \\})();
;

// ── Tests ───────────────────────────────────────────────────────────────────
//
// `zig build test` runs these plus the comptime assertions above, which is
// where a wrong extension-point id or a mistyped export name is caught.

test "the manifest declares both points and carries its own capabilities" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon-clipboard\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "window.theme_changed") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "clipboard.read") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "clipboard.write") != null);
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

test "writeResult NUL-terminates and reports overflow as null" {
    var buf: [8]u8 = undefined;
    writeResult(&buf, buf.len, "\"hi\"");
    try std.testing.expectEqualStrings("\"hi\"", std.mem.sliceTo(&buf, 0));

    writeResult(&buf, buf.len, "\"aaaaaaaaaaaaaaaaaaaa\"");
    try std.testing.expectEqualStrings("null", std.mem.sliceTo(&buf, 0));
}

test "parseFirstString reads the first element, and refuses the rest" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try std.testing.expectEqualStrings("hello", try parseFirstString(a, "[\"hello\"]"));
    try std.testing.expectError(error.TextArgumentNotAString, parseFirstString(a, "[42]"));
    try std.testing.expectError(error.MissingTextArgument, parseFirstString(a, "[]"));
    try std.testing.expectError(error.ArgumentsNotAnArray, parseFirstString(a, "{}"));
    try std.testing.expectError(error.BadArgumentsJson, parseFirstString(a, "not json"));
}
