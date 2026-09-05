// bluetooth — BLE scan, connect, GATT-notify-subscribe, and characteristic
// write (Windows only for now; see bluetooth_*'s own doc comment in
// carbon_plugin.h and the host-side bluetooth.rs header for the full
// scope note — a one-shot GATT read, full service/characteristic
// enumeration, and macOS/Linux are NOT covered here).
//
//   carbon plugin add bluetooth
//
//   import { scanStart, scanStop, connect, subscribe, writeCharacteristic } from "@carbon/plugins/bluetooth";
//   scanStart();
//   carbon.on("bluetooth.device", ({ address, name, rssi }) => { ... });
//   connect("AA:BB:CC:DD:EE:FF");
//   carbon.on("bluetooth.connected", ({ address }) => {
//     subscribe(address, serviceUuid, charUuid);
//     carbon.on("bluetooth.notify." + charUuid, (bytes) => { ... }); // Uint8Array
//   });
//   writeCharacteristic(address, serviceUuid, charUuid, [1, 2, 3]); // plain number array
//
// `writeCharacteristic`'s bytes argument must be a plain JS Array of byte
// values, NOT a raw Uint8Array: every JS->native call in this ABI is
// marshaled through the engine's own `JSON.stringify`, and
// `JSON.stringify(someUint8Array)` produces an OBJECT with numeric-string
// keys (`{"0":1,"1":2}`), not an array — a real, easy-to-miss JS
// footgun, not a Carbon-specific one. `@carbon/plugins/bluetooth`'s TS
// wrapper (`useBluetooth()`) accepts a real `Uint8Array` and converts it
// with `Array.from(...)` before calling this global, so app code never
// hits this directly — call the native global below only if bypassing
// that wrapper.
//
// Every call here DISPATCHES an operation and returns immediately — none
// of the interesting outcomes are this call's return value. See the
// events above and the ABI doc comment for the full event catalog
// (`bluetooth.device`, `bluetooth.connected`/`connect_error`,
// `bluetooth.subscribed`/`subscribe_error`, `bluetooth.write_result`, and
// the per-characteristic `bluetooth.notify.<uuid>` binary event).
//
//   zig build                     build it
//   carbon plugin add bluetooth   fetch + build + install into the app
//   carbon plugin check           verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "bluetooth",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:bluetooth"},
    .exports = &.{
        .{ .name = "scanStart" },
        .{ .name = "scanStop" },
        .{ .name = "connect" },
        .{ .name = "subscribe" },
        .{ .name = "writeCharacteristic" },
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

// ── JS listener shim — see media's/global-shortcuts' main.zig for the
// full rationale (each piece independently idempotent-guarded against a
// NAMED global, safe regardless of plugin load order). Needed so
// `bluetooth.device`/`connected`/`subscribed`/`write_result` (JSON) and
// `bluetooth.notify.<uuid>` (binary) events are actually deliverable.
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

fn installGlobals(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("scanStart", jsScanStart);
    _ = app.setGlobalFunction("scanStop", jsScanStop);
    _ = app.setGlobalFunction("connect", jsConnect);
    _ = app.setGlobalFunction("subscribe", jsSubscribe);
    _ = app.setGlobalFunction("writeCharacteristic", jsWriteCharacteristic);
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

fn stringAt(args: []const std.json.Value, idx: usize) ?[]const u8 {
    if (idx >= args.len) return null;
    return switch (args[idx]) {
        .string => |s| s,
        else => null,
    };
}

// ── scanStart() / scanStop() → boolean ──────────────────────────────────

fn jsScanStart(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.bluetoothScanStart() == sdk.CARBON_OK);
}

fn jsScanStop(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.bluetoothScanStop() == sdk.CARBON_OK);
}

// ── connect(address) → boolean (dispatched, not connected — see header) ──

fn jsConnect(
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
        const address_raw = stringAt(args, 0) orelse break :blk false;
        const address_z = allocator.dupeZ(u8, address_raw) catch break :blk false;
        break :blk app.bluetoothConnect(address_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── subscribe(address, serviceUuid, characteristicUuid) → boolean ────────

fn jsSubscribe(
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
        const address_raw = stringAt(args, 0) orelse break :blk false;
        const service_raw = stringAt(args, 1) orelse break :blk false;
        const char_raw = stringAt(args, 2) orelse break :blk false;
        const address_z = allocator.dupeZ(u8, address_raw) catch break :blk false;
        const service_z = allocator.dupeZ(u8, service_raw) catch break :blk false;
        const char_z = allocator.dupeZ(u8, char_raw) catch break :blk false;
        break :blk app.bluetoothSubscribe(address_z.ptr, service_z.ptr, char_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── writeCharacteristic(address, serviceUuid, characteristicUuid, bytes) → boolean ─

fn jsWriteCharacteristic(
    ctx: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    _ = ctx;
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    const ok = blk: {
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const args = parseArgs(args_json, allocator);
        const address_raw = stringAt(args, 0) orelse break :blk false;
        const service_raw = stringAt(args, 1) orelse break :blk false;
        const char_raw = stringAt(args, 2) orelse break :blk false;
        // Fourth arg: a JSON array of byte values (Uint8Array serializes
        // to JSON as a plain number array through this JS<->host bridge,
        // the same shape sqlite.rs's blob params expect).
        const data_values: []const std.json.Value = if (args.len > 3) switch (args[3]) {
            .array => |a| a.items,
            else => &.{},
        } else &.{};
        var data = allocator.alloc(u8, data_values.len) catch break :blk false;
        for (data_values, 0..) |v, i| {
            data[i] = switch (v) {
                .integer => |n| @intCast(@max(0, @min(255, n))),
                else => 0,
            };
        }
        const address_z = allocator.dupeZ(u8, address_raw) catch break :blk false;
        const service_z = allocator.dupeZ(u8, service_raw) catch break :blk false;
        const char_z = allocator.dupeZ(u8, char_raw) catch break :blk false;
        break :blk app.bluetoothWriteCharacteristic(address_z.ptr, service_z.ptr, char_z.ptr, data) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"bluetooth\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
