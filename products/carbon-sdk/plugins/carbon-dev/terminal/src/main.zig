// terminal — host a real terminal (xterm.js-style) or spawn a shell/AI
// coding agent, backed by a real Windows ConPTY session.
//
//   carbon plugin add terminal
//
//   import { spawn, write, resize, read, kill, close, wait } from "carbon:terminal";
//
// Ported from solutions/infrastructure/os/adapters/process/pty.rs (an
// always-on `__cm_pty_*` global that shipped in every app regardless of
// whether it hosted a terminal), with the OS work moved from `portable-pty`
// (Rust) into this plugin's own Zig code — see pty_win.zig's header for the
// real ConPTY mechanics, and its own header for why this is a genuine
// reimplementation, not a port: nothing here can lean on a host ABI
// capability, because hosting a terminal was never part of the frozen
// plugin ABI (unlike clipboard/dialog/etc).
//
//   zig build                   build it
//   carbon plugin add terminal  fetch + build + install into the current app
//   carbon plugin check         verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");
const pty = @import("pty_win.zig");

/// Zig 0.16 moved Mutex under `std.Io.Mutex`, whose lock/unlock now take an
/// `Io` argument (async-cancellation-aware) — overkill for the plain,
/// short, uncontended critical sections here (a hashmap insert/lookup, a
/// buffer append), and this file has no natural `Io` instance to thread
/// through the reader threads anyway. A minimal CAS spinlock is simpler and
/// correct for that shape of use.
const SpinLock = struct {
    locked: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    fn lock(self: *SpinLock) void {
        while (self.locked.cmpxchgWeak(false, true, .acquire, .monotonic) != null) {
            std.atomic.spinLoopHint();
        }
    }

    fn unlock(self: *SpinLock) void {
        self.locked.store(false, .release);
    }
};

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "terminal",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload", "lifecycle.shutdown" },
    .modules = &.{"carbon:terminal"},
    .exports = &.{
        .{ .name = "spawn" },
        .{ .name = "write" },
        .{ .name = "resize" },
        .{ .name = "read" },
        .{ .name = "kill" },
        .{ .name = "close" },
        .{ .name = "wait" },
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

// Same shim carbon-hotkey/global-shortcuts install — `app.pushEvent` lands
// on the host side with nothing in the JS runtime to turn it into a
// listenable event by default; each plugin using it brings its own,
// guarded so a second plugin doing the same thing is a no-op.
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

/// Close every still-open session so a child process (a shell, an agent)
/// never outlives the app that spawned it.
pub fn carbon_plugin_on_shutdown(app_raw: *sdk.RawApp) callconv(.c) void {
    _ = app_raw;
    closeAllSessions();
}
comptime {
    sdk.ext.implement("lifecycle.shutdown", carbon_plugin_on_shutdown);
}

fn installGlobals(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("spawn", jsSpawn);
    _ = app.setGlobalFunction("write", jsWrite);
    _ = app.setGlobalFunction("resize", jsResize);
    _ = app.setGlobalFunction("read", jsRead);
    _ = app.setGlobalFunction("kill", jsKill);
    _ = app.setGlobalFunction("close", jsClose);
    _ = app.setGlobalFunction("wait", jsWait);
}

// ── Session registry ─────────────────────────────────────────────────────────
//
// One entry per spawned session: the ConPTY session itself, a byte buffer
// the reader thread fills and read() drains, and the reader thread handle
// so close() can join it. Global + heap-allocated (not arena-scoped like
// the per-call JS functions below) because a session outlives any single
// JS call — it lives from spawn() to close().

const Entry = struct {
    session: pty.Session,
    buf_mutex: SpinLock = .{},
    buf: std.ArrayList(u8) = .empty,
    reader_thread: ?std.Thread = null,
    // Closes the pseudoconsole as soon as the child exits — see
    // pty.Session.watchForExit's doc comment for why this is needed at all
    // (conhost doesn't signal EOF on process exit by itself).
    exit_watcher_thread: ?std.Thread = null,
    gpa: std.mem.Allocator,
};

var registry_mutex: SpinLock = .{};
var registry: std.AutoHashMap(u32, *Entry) = std.AutoHashMap(u32, *Entry).init(std.heap.page_allocator);
var next_id_counter: std.atomic.Value(u32) = std.atomic.Value(u32).init(1);

fn nextId() u32 {
    return next_id_counter.fetchAdd(1, .monotonic);
}

fn readerThreadMain(id: u32, entry: *Entry) void {
    var chunk: [8192]u8 = undefined;
    while (true) {
        const n = entry.session.read(&chunk);
        if (n == 0) break; // EOF — child exited and ConPTY drained.
        {
            entry.buf_mutex.lock();
            defer entry.buf_mutex.unlock();
            entry.buf.appendSlice(entry.gpa, chunk[0..n]) catch break;
        }
        if (g_app) |app| {
            var payload_buf: [64]u8 = undefined;
            const payload = std.fmt.bufPrintZ(&payload_buf, "{{\"id\":{d}}}", .{id}) catch "{}";
            _ = app.pushEvent("pty-output", payload);
        }
    }
    if (g_app) |app| {
        var payload_buf: [64]u8 = undefined;
        const payload = std.fmt.bufPrintZ(&payload_buf, "{{\"id\":{d}}}", .{id}) catch "{}";
        _ = app.pushEvent("pty-exit", payload);
    }
}

fn exitWatcherThreadMain(entry: *Entry) void {
    entry.session.watchForExit();
}

fn closeAllSessions() void {
    registry_mutex.lock();
    var it = registry.iterator();
    var ids: std.ArrayList(u32) = .empty;
    while (it.next()) |kv| ids.append(std.heap.page_allocator, kv.key_ptr.*) catch {};
    registry_mutex.unlock();
    for (ids.items) |id| closeSession(id);
}

fn closeSession(id: u32) void {
    registry_mutex.lock();
    const entry = registry.fetchRemove(id);
    registry_mutex.unlock();
    if (entry) |kv| {
        const e = kv.value;
        e.session.deinit(e.gpa); // kills the child if still running, closes the pseudoconsole
        if (e.reader_thread) |t| t.join();
        if (e.exit_watcher_thread) |t| t.join();
        e.gpa.destroy(e);
    }
}

// ── JSON arg helpers (same shape as file-search's) ──────────────────────────

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}
fn writeNull(buf: [*c]u8, cap: usize) void {
    writeResult(buf, cap, "null");
}
fn writeBool(buf: [*c]u8, cap: usize, v: bool) void {
    writeResult(buf, cap, if (v) "true" else "false");
}
fn writeNum(buf: [*c]u8, cap: usize, v: anytype) void {
    var tmp: [24]u8 = undefined;
    const w = std.fmt.bufPrint(&tmp, "{d}", .{v}) catch return writeNull(buf, cap);
    writeResult(buf, cap, w);
}
fn writeStr(a: std.mem.Allocator, buf: [*c]u8, cap: usize, s: []const u8) void {
    var out: std.ArrayList(u8) = .empty;
    jsonQuoteAppend(a, &out, s) catch return writeNull(buf, cap);
    writeResult(buf, cap, out.items);
}

fn jsonQuoteAppend(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    try out.append(a, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(a, "\\\""),
            '\\' => try out.appendSlice(a, "\\\\"),
            '\n' => try out.appendSlice(a, "\\n"),
            '\r' => try out.appendSlice(a, "\\r"),
            '\t' => try out.appendSlice(a, "\\t"),
            0x00...0x08, 0x0b...0x0c, 0x0e...0x1f => {
                var tmp: [6]u8 = undefined;
                const w = std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}) catch continue;
                try out.appendSlice(a, w);
            },
            else => try out.append(a, c),
        }
    }
    try out.append(a, '"');
}

fn parseArgArray(a: std.mem.Allocator, args_json: [*c]const u8) []std.json.Value {
    if (args_json == null) return &.{};
    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, a, raw, .{}) catch return &.{};
    return switch (parsed.value) {
        .array => |ar| ar.items,
        else => &.{},
    };
}

fn strAt(args: []const std.json.Value, i: usize) ?[]const u8 {
    if (i >= args.len) return null;
    return switch (args[i]) {
        .string => |s| s,
        else => null,
    };
}
fn u32At(args: []const std.json.Value, i: usize) ?u32 {
    if (i >= args.len) return null;
    return switch (args[i]) {
        .integer => |n| if (n < 0) null else @intCast(n),
        .float => |f| if (f < 0) null else @intFromFloat(f),
        else => null,
    };
}

fn getStr(obj: std.json.Value, key: []const u8) ?[]const u8 {
    const o = switch (obj) {
        .object => |m| m,
        else => return null,
    };
    const v = o.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}
fn getU16(obj: std.json.Value, key: []const u8, default: u16) u16 {
    const o = switch (obj) {
        .object => |m| m,
        else => return default,
    };
    const v = o.get(key) orelse return default;
    return switch (v) {
        .integer => |n| if (n < 1 or n > std.math.maxInt(u16)) default else @intCast(n),
        else => default,
    };
}
fn getStrArray(a: std.mem.Allocator, obj: std.json.Value, key: []const u8) [][]const u8 {
    const o = switch (obj) {
        .object => |m| m,
        else => return &.{},
    };
    const v = o.get(key) orelse return &.{};
    const arr = switch (v) {
        .array => |ar| ar.items,
        else => return &.{},
    };
    var out = a.alloc([]const u8, arr.len) catch return &.{};
    var n: usize = 0;
    for (arr) |item| {
        switch (item) {
            .string => |s| {
                out[n] = s;
                n += 1;
            },
            else => {},
        }
    }
    return out[0..n];
}
fn getEnvEntries(a: std.mem.Allocator, obj: std.json.Value, key: []const u8) []pty.EnvEntry {
    const o = switch (obj) {
        .object => |m| m,
        else => return &.{},
    };
    const v = o.get(key) orelse return &.{};
    const map = switch (v) {
        .object => |m| m,
        else => return &.{},
    };
    var out: std.ArrayList(pty.EnvEntry) = .empty;
    var it = map.iterator();
    while (it.next()) |kv| {
        switch (kv.value_ptr.*) {
            .string => |s| out.append(a, .{ .key = kv.key_ptr.*, .value = s }) catch {},
            else => {},
        }
    }
    return out.toOwnedSlice(a) catch &.{};
}

// ── spawn({cmd, args?, cwd?, env?, cols?, rows?}) → id | null ───────────────

fn jsSpawn(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const args = parseArgArray(a, args_json);
    if (args.len == 0) return writeNull(result_buf, result_buf_len);
    const opts = args[0];
    const cmd = getStr(opts, "cmd") orelse return writeNull(result_buf, result_buf_len);
    const cmd_args = getStrArray(a, opts, "args");
    const cwd = getStr(opts, "cwd");
    const env = getEnvEntries(a, opts, "env");
    const cols = getU16(opts, "cols", 80);
    const rows = getU16(opts, "rows", 24);

    // The session and its registry entry outlive this call — real gpa, not
    // the per-call arena.
    const gpa = std.heap.page_allocator;
    const session = pty.Session.spawn(gpa, cmd, cmd_args, cwd, env, cols, rows) catch {
        return writeNull(result_buf, result_buf_len);
    };

    const entry = gpa.create(Entry) catch {
        var s = session;
        s.deinit(gpa);
        return writeNull(result_buf, result_buf_len);
    };
    entry.* = .{ .session = session, .gpa = gpa };

    const id = nextId();
    registry_mutex.lock();
    registry.put(id, entry) catch {
        registry_mutex.unlock();
        entry.session.deinit(gpa);
        gpa.destroy(entry);
        return writeNull(result_buf, result_buf_len);
    };
    registry_mutex.unlock();

    entry.reader_thread = std.Thread.spawn(.{}, readerThreadMain, .{ id, entry }) catch null;
    entry.exit_watcher_thread = std.Thread.spawn(.{}, exitWatcherThreadMain, .{entry}) catch null;
    writeNum(result_buf, result_buf_len, id);
}

// ── write(id, data) → bytesWritten ──────────────────────────────────────────

fn jsWrite(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = parseArgArray(a, args_json);
    const id = u32At(args, 0) orelse return writeNum(result_buf, result_buf_len, @as(u32, 0));
    const data = strAt(args, 1) orelse return writeNum(result_buf, result_buf_len, @as(u32, 0));

    registry_mutex.lock();
    const entry = registry.get(id);
    registry_mutex.unlock();
    if (entry) |e| {
        writeNum(result_buf, result_buf_len, e.session.write(data));
    } else {
        writeNum(result_buf, result_buf_len, @as(u32, 0));
    }
}

// ── resize(id, cols, rows) → boolean ────────────────────────────────────────

fn jsResize(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = parseArgArray(a, args_json);
    const id = u32At(args, 0) orelse return writeBool(result_buf, result_buf_len, false);
    const cols = u32At(args, 1) orelse return writeBool(result_buf, result_buf_len, false);
    const rows = u32At(args, 2) orelse return writeBool(result_buf, result_buf_len, false);

    registry_mutex.lock();
    const entry = registry.get(id);
    registry_mutex.unlock();
    if (entry) |e| {
        const c: u16 = @intCast(@min(cols, std.math.maxInt(u16)));
        const r: u16 = @intCast(@min(rows, std.math.maxInt(u16)));
        writeBool(result_buf, result_buf_len, e.session.resize(c, r));
    } else {
        writeBool(result_buf, result_buf_len, false);
    }
}

// ── read(id) → base64 string ────────────────────────────────────────────────

fn jsRead(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = parseArgArray(a, args_json);
    const id = u32At(args, 0) orelse return writeResult(result_buf, result_buf_len, "\"\"");

    registry_mutex.lock();
    const entry = registry.get(id);
    registry_mutex.unlock();
    const e = entry orelse return writeResult(result_buf, result_buf_len, "\"\"");

    e.buf_mutex.lock();
    const bytes = e.buf.toOwnedSlice(e.gpa) catch &.{};
    e.buf = .empty;
    e.buf_mutex.unlock();
    defer if (bytes.len > 0) e.gpa.free(bytes);

    if (bytes.len == 0) return writeResult(result_buf, result_buf_len, "\"\"");
    const encoded = a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len)) catch {
        return writeResult(result_buf, result_buf_len, "\"\"");
    };
    _ = std.base64.standard.Encoder.encode(encoded, bytes);
    writeStr(a, result_buf, result_buf_len, encoded);
}

// ── kill(id) ─────────────────────────────────────────────────────────────────

fn jsKill(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = parseArgArray(a, args_json);
    const id = u32At(args, 0) orelse return writeNull(result_buf, result_buf_len);

    registry_mutex.lock();
    const entry = registry.get(id);
    registry_mutex.unlock();
    if (entry) |e| e.session.kill();
    writeNull(result_buf, result_buf_len);
}

// ── close(id) ────────────────────────────────────────────────────────────────

fn jsClose(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = parseArgArray(a, args_json);
    const id = u32At(args, 0) orelse return writeNull(result_buf, result_buf_len);
    closeSession(id);
    writeNull(result_buf, result_buf_len);
}

// ── wait(id) → exitCode (blocks the calling — JS — thread until exit) ──────

fn jsWait(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = parseArgArray(a, args_json);
    const id = u32At(args, 0) orelse return writeNum(result_buf, result_buf_len, @as(i32, -1));

    registry_mutex.lock();
    const entry = registry.get(id);
    registry_mutex.unlock();
    if (entry) |e| {
        writeNum(result_buf, result_buf_len, e.session.wait());
    } else {
        writeNum(result_buf, result_buf_len, @as(i32, -1));
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares its identity and lifecycle points" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"terminal\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.shutdown") != null);
}

test "carbon-plugin.toml generation lists all seven exports" {
    const toml = comptime sdk.manifest.toToml(CFG);
    inline for (.{ "spawn", "write", "resize", "read", "kill", "close", "wait" }) |name| {
        try std.testing.expect(std.mem.indexOf(u8, toml, "\"" ++ name ++ "\"") != null);
    }
}

test "id allocation is monotonic and never repeats" {
    const first = nextId();
    const second = nextId();
    try std.testing.expect(second > first);
}
