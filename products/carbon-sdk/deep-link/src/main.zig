// deep-link — custom URL scheme handling (`myapp://...`).
//
//   carbon plugin add deep-link
//
//   import { useDeepLink } from "@carbon/plugins/deep-link";
//   useDeepLink("myapp", (url) => console.log("opened via", url));
//
// Self-registers the scheme with the OS on Windows (user-scope registry)
// and Linux (~/.local/share/applications .desktop + xdg-mime) at runtime.
// macOS genuinely cannot do this at runtime — CFBundleURLTypes must be in
// Info.plist at package time — so `register()` returns false there; see
// solutions/infrastructure/plugin-host/native/deeplink.rs for the full
// platform-by-platform picture, including the loopback-TCP single-instance
// mechanism and its known "brief window flash" limitation.
//
// `register()` may not return at all: if this launch's argv carried a
// `<scheme>://` URL and another instance is already running, the native
// call forwards it and exits the process directly.
//
//   zig build                    build it
//   carbon plugin add deep-link  fetch + build + install into the current app
//   carbon plugin check          verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "deep-link",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:deep-link"},
    // Prefixed, not bare "register" — collided with the global-shortcuts
    // plugin's own "register" export when both are loaded in the same app
    // (see installGlobals below).
    .exports = &.{.{ .name = "register", .global = "deepLinkRegister" }},
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

// ── JS listener shim — see global-shortcuts' main.zig for the full
// rationale (same shim, `carbon.on`/`carbon.off`).
const EVENT_SHIM =
    \\if(!globalThis.__carbon_on_event){
    \\  (function(){
    \\    var listeners = Object.create(null);
    \\    globalThis.__carbon_on_event = function(name, payloadJson){
    \\      var payload = null;
    \\      try { payload = JSON.parse(payloadJson); } catch(e) {}
    \\      var arr = listeners[name];
    \\      if (!arr) return;
    \\      for (var i = 0; i < arr.length; i++) {
    \\        try { arr[i](payload); } catch(e) {}
    \\      }
    \\    };
    \\    globalThis.carbon = globalThis.carbon || {};
    \\    globalThis.carbon.on = function(name, cb){
    \\      (listeners[name] || (listeners[name] = [])).push(cb);
    \\    };
    \\    globalThis.carbon.off = function(name, cb){
    \\      var arr = listeners[name];
    \\      if (!arr) return;
    \\      var idx = arr.indexOf(cb);
    \\      if (idx !== -1) arr.splice(idx, 1);
    \\    };
    \\  })();
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
    // Prefixed, not bare "register" — see carbon-plugin.toml's note on the
    // collision this avoids with the global-shortcuts plugin.
    _ = app.setGlobalFunction("deepLinkRegister", jsRegister);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── register(scheme) → boolean ──────────────────────────────────────────────
//
// NOTE: `app.deeplinkRegister` may not return at all — see the ABI's own
// doc comment on `deeplink_register`. When it does return, the boolean
// result written here still matters (macOS always false; a registry/
// filesystem write failure elsewhere also false).

fn jsRegister(
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
        if (args_json == null) break :blk false;
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const allocator = arena.allocator();

        const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
        const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch break :blk false;
        const args = switch (parsed.value) {
            .array => |a| a.items,
            else => break :blk false,
        };
        if (args.len == 0) break :blk false;
        const scheme = switch (args[0]) {
            .string => |s| s,
            else => break :blk false,
        };
        const scheme_z = allocator.dupeZ(u8, scheme) catch break :blk false;
        break :blk app.deeplinkRegister(scheme_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"deep-link\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
