// biometrics — Windows Hello user-consent verification (fingerprint /
// face / PIN, whatever the device and user have configured). Windows
// only for now; see biometric_verify's own doc comment in carbon_plugin.h
// and the host-side biometrics.rs header for the full scope note —
// macOS Touch ID/Face ID and a Linux equivalent are NOT covered here.
//
//   carbon plugin add biometrics
//
//   import { verifyIdentity } from "@carbon/plugins/biometrics";
//   verifyIdentity("Unlock your vault");
//   carbon.on("biometrics.result", ({ verified, result }) => { ... });
//
// verifyIdentity() only DISPATCHES the request and returns immediately —
// it is NOT a yes/no answer itself. The OS shows its own native
// verification prompt, and the eventual outcome arrives asynchronously as
// a `biometrics.result` event (`result` is one of "verified"|
// "deviceNotPresent"|"notConfigured"|"disabledByPolicy"|"deviceBusy"|
// "retriesExhausted"|"canceled"|"error"). See biometrics.rs's own header
// comment for why this can't be a synchronous return value: the
// underlying WinRT call can only be awaited with a blocking,
// non-message-pumping wait, which would deadlock the JS/event-loop
// thread's own apartment.
//
//   zig build                     build it
//   carbon plugin add biometrics  fetch + build + install into the app
//   carbon plugin check           verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "biometrics",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:biometrics"},
    .exports = &.{.{ .name = "verifyIdentity" }},
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
// full rationale (same shim, `carbon.on`/`carbon.off`, guarded so a
// second plugin installing it is a no-op). Needed so `biometrics.result`
// events are actually deliverable.
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

fn installGlobals(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("verifyIdentity", jsVerifyIdentity);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── verifyIdentity(message?) → boolean (dispatched, not the verification
// outcome — see this file's header comment) ─────────────────────────────

fn jsVerifyIdentity(
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

        var message_raw: []const u8 = "";
        if (args_json != null) parse_args: {
            const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
            const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch break :parse_args;
            const args = switch (parsed.value) {
                .array => |a| a.items,
                else => break :parse_args,
            };
            if (args.len == 0) break :parse_args;
            message_raw = switch (args[0]) {
                .string => |s| s,
                else => break :parse_args,
            };
        }
        const message_z = allocator.dupeZ(u8, message_raw) catch break :blk false;
        break :blk app.biometricVerify(message_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"biometrics\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
