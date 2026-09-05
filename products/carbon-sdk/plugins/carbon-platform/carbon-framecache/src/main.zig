// carbon-framecache — startup frame-cache diagnostics and control for
// apps and dev tooling that care about their own cold-start time. Not an
// OS or hosted-cloud capability — introspects
// `products/carbon/composition/frame_cache.rs`'s on-disk warm-start
// cache. See carbon_plugin.h's ABI 1.23 doc comment and the host-side
// framecache.rs header for the full picture (mini-backend only; always
// `hit:false` on blitz, not a failure).
//
//   carbon plugin add carbon-framecache
//
//   import { getStats, clear } from "@carbon/plugins/carbon-framecache";
//   const { hit } = getStats(); // was THIS launch served from the cache
//   clear(); // force the next launch to rebuild it
//
//   zig build                           build it
//   carbon plugin add carbon-framecache fetch + build + install into the app
//   carbon plugin check                 verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "carbon-framecache",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:carbon-framecache"},
    .exports = &.{
        .{ .name = "getStats" },
        .{ .name = "clear" },
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
    _ = app.setGlobalFunction("getStats", jsGetStats);
    _ = app.setGlobalFunction("clear", jsClear);
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

// ── getStats() → {hit} | null ────────────────────────────────────────────

fn jsGetStats(
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
    const ptr = app.framecacheStats(&status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
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
    writeBoolResult(result_buf, result_buf_len, app.framecacheClear() == sdk.CARBON_OK);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon-framecache\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
