// microphone — live PCM capture (Windows only for now; see
// microphone_start's own doc comment in carbon_plugin.h and the host-side
// microphone.rs header for the full scope note — device enumeration/
// selection, gain control, voice-activity detection, system-audio
// loopback, and macOS/Linux are NOT covered here).
//
//   carbon plugin add microphone
//
//   import { start, stop } from "@carbon/plugins/microphone";
//   start();
//   carbon.on("microphone.started", ({ sampleRate, channels }) => { ... });
//   carbon.on("microphone.frame", (bytes) => { ... }); // Float32Array-backed Uint8Array, interleaved
//   stop();
//
// `start()` only DISPATCHES capture setup and returns immediately — the
// outcome arrives as `microphone.started`/`microphone.start_error`. Every
// audio quantum after that (device-dependent, commonly ~10ms) delivers a
// `microphone.frame` binary event: raw bytes of interleaved 32-bit float
// PCM (WinRT's AudioGraph always normalizes to this format regardless of
// the source device), `bytes.length / 4 / channels` samples per channel —
// view it as `new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)`
// to get actual sample values.
//
//   zig build                       build it
//   carbon plugin add microphone    fetch + build + install into the app
//   carbon plugin check             verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "microphone",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:microphone"},
    // `global` overrides are required here: camera's plugin also exports
    // bare `start`/`stop`, and every plugin's globals share ONE
    // globalThis namespace at runtime (see manifest.zig's `Export.global`
    // doc comment) — without this, whichever of camera/microphone
    // registers second would silently overwrite the other's `start`/
    // `stop`. The JS-facing import name (`start`/`stop` from
    // `carbon:microphone`) is unaffected; only the underlying globalThis
    // property differs.
    .exports = &.{
        .{ .name = "start", .global = "__carbon_microphone_start" },
        .{ .name = "stop", .global = "__carbon_microphone_stop" },
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

// ── JS listener shim — see bluetooth's/media's main.zig for the full
// rationale (each piece independently idempotent-guarded against a NAMED
// global, safe regardless of plugin load order). Needed so
// `microphone.started`/`start_error` (JSON) and `microphone.frame`
// (binary) events are actually deliverable.
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
    _ = app.setGlobalFunction("__carbon_microphone_start", jsStart);
    _ = app.setGlobalFunction("__carbon_microphone_stop", jsStop);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── start() / stop() → boolean (dispatched, not completed — see header) ──

fn jsStart(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.microphoneStart() == sdk.CARBON_OK);
}

fn jsStop(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.microphoneStop() == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"microphone\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
