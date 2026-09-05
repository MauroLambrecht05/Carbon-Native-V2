// carbon-manifest — reads the app's own carbon.toml at runtime, so app
// code can introspect what it's actually permitted to do instead of
// guessing or hard-coding it. Not an OS or hosted-cloud capability — see
// carbon_plugin.h's ABI 1.23 doc comment and the host-side
// carbon_manifest.rs header for the full picture and what's deliberately
// excluded ([dev-signing] trusted_keys, each plugin's free-form config).
//
//   carbon plugin add carbon-manifest
//
//   import { readManifest } from "@carbon/plugins/carbon-manifest";
//   const m = readManifest();
//   // m.app: {name, version, displayName, window: {...}}
//   // m.runtime: {backend, bytecode, image, audio}
//   // m.capabilities: {fsRead, fsWrite, netFetch, systemNotify, imageRead}
//   // m.plugins: {"<name>": {capabilities: [...]}, ...}
//
// Re-parses carbon.toml fresh on every call — cheap, and the file can
// change under `carbon dev`.
//
//   zig build                         build it
//   carbon plugin add carbon-manifest fetch + build + install into the app
//   carbon plugin check               verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "carbon-manifest",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:carbon-manifest"},
    .exports = &.{.{ .name = "readManifest" }},
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
    _ = app.setGlobalFunction("readManifest", jsReadManifest);
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── readManifest() → {app, runtime, capabilities, plugins} | null ─────────

fn jsReadManifest(
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
    const ptr = app.manifestRead(&status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    // Already a JSON object from the host side — passed through as-is,
    // same convention as theme's queryThemePrefs.
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon-manifest\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
