// shortcuts — system-wide keyboard shortcuts that fire even when the app
// is unfocused or minimized. Plugin name "shortcuts"; installs the
// "carbon:global-shortcuts" JS module (unchanged from before this plugin's
// own folder/install-name was shortened).
//
//   carbon plugin add shortcuts
//
//   import { useGlobalShortcut } from "@carbon/plugins/global-shortcuts";
//   useGlobalShortcut("Ctrl+Alt+P", () => console.log("summoned"));
//
// Cross-platform (Windows/macOS/Linux-X11) via the `global-hotkey` Rust
// crate on the host side (solutions/infrastructure/plugin-host/native/
// global_shortcuts.rs) — this plugin is a thin bridge, same shape as
// clipboard/dialog/notification/keychain, plus the event-delivery pattern
// already prototyped in labs/examples/pulse/carbon/plugins/local/carbon-hotkey (a
// background thread pushing events via `app.pushEvent`, and a JS-side
// pub/sub shim installed via `app.eval` since nothing in the runtime
// automatically wires push_event payloads to a JS listener).
//
//   zig build                     build it
//   carbon plugin add shortcuts   fetch + build + install
//   carbon plugin check           verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "shortcuts",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:global-shortcuts"},
    // Prefixed globals, not bare "register"/"unregister" — collided with
    // the deeplink plugin's own "register" export when both are loaded
    // in the same app (see installGlobals below).
    .exports = &.{
        .{ .name = "register", .global = "globalShortcutRegister" },
        .{ .name = "unregister", .global = "globalShortcutUnregister" },
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

// ── JS listener shim ─────────────────────────────────────────────────────
//
// `app.pushEvent` lands on the host side, but nothing in the JS runtime
// automatically turns that into a listenable event — each plugin using
// pushEvent brings its own shim, guarded so a second plugin doing the same
// thing is a no-op. Adds `carbon.off` on top of the shim
// labs/examples/pulse/carbon/plugins/local/carbon-hotkey prototyped, since this plugin
// supports registering (and un-registering) many different accelerators
// over a component's lifetime, unlike that single-fixed-hotkey example.
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

// ── lifecycle.register / lifecycle.after_reload ─────────────────────────────
//
// `pub`, not a bare `fn`: see sdk.ext.implement's doc comment — a static
// release build's generated umbrella reaches these through `@import`, which
// only works for `pub` declarations.

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
    // Prefixed, not bare "register"/"unregister" — see carbon-plugin.toml's
    // note on the collision this avoids with the deep-link plugin.
    _ = app.setGlobalFunction("globalShortcutRegister", jsRegister);
    _ = app.setGlobalFunction("globalShortcutUnregister", jsUnregister);
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    writeResult(buf, cap, if (v) "true" else "false");
}

fn firstStringArg(args_json: [*c]const u8, allocator: std.mem.Allocator) ?[:0]const u8 {
    if (args_json == null) return null;
    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch return null;
    const args = switch (parsed.value) {
        .array => |a| a.items,
        else => return null,
    };
    if (args.len == 0) return null;
    const s = switch (args[0]) {
        .string => |v| v,
        else => return null,
    };
    return allocator.dupeZ(u8, s) catch null;
}

// ── register(accelerator) → number | null ───────────────────────────────────

fn jsRegister(
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
    const accelerator = firstStringArg(args_json, arena.allocator()) orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    var id: u32 = 0;
    if (app.globalShortcutRegister(accelerator.ptr, &id) != sdk.CARBON_OK) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    var buf: [16]u8 = undefined;
    const written = std.fmt.bufPrint(&buf, "{d}", .{id}) catch {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    writeResult(result_buf, result_buf_len, written);
}

// ── unregister(accelerator) → boolean ───────────────────────────────────────

fn jsUnregister(
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
    const accelerator = firstStringArg(args_json, arena.allocator()) orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.globalShortcutUnregister(accelerator.ptr) == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"shortcuts\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
