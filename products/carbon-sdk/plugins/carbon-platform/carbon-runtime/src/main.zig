// carbon-runtime — introspects which Carbon backend binary is running and
// which of its own Cargo feature flags were compiled in. Not an OS or
// hosted-cloud capability — Carbon self-introspection, see carbon_plugin.h's
// ABI 1.23 doc comment and the host-side host_exports.rs header for the
// full picture (why this is three plain fields, not a native call: the
// data is computed once at process startup by the composition root and
// never changes for the life of the session).
//
//   carbon plugin add carbon-runtime
//
//   import { getRuntimeInfo } from "@carbon/plugins/carbon-runtime";
//   const { backend, features, abiVersion } = getRuntimeInfo();
//   // backend: "mini" | "blitz"
//   // features: {network, svg, image, audio, updater, snapshot, gpu, profiling}
//   // abiVersion: {major, minor}
//
//   zig build                        build it
//   carbon plugin add carbon-runtime fetch + build + install into the app
//   carbon plugin check              verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "carbon-runtime",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:carbon-runtime"},
    .exports = &.{.{ .name = "getRuntimeInfo" }},
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
    _ = app.setGlobalFunction("getRuntimeInfo", jsGetRuntimeInfo);
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── getRuntimeInfo() → {backend, features, abiVersion} | null ──────────────

fn jsGetRuntimeInfo(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };

    const backend_c = app.backendName();
    const backend = if (backend_c != null) std.mem.span(backend_c) else "";
    const features_c = app.runtimeFeaturesJson();
    const features = if (features_c != null) std.mem.span(features_c) else "{}";
    const ver = app.abiVersion();

    var buf: [512]u8 = undefined;
    const json = std.fmt.bufPrint(
        &buf,
        "{{\"backend\":\"{s}\",\"features\":{s},\"abiVersion\":{{\"major\":{d},\"minor\":{d}}}}}",
        .{ backend, features, ver.major, ver.minor },
    ) catch {
        writeResult(result_buf, result_buf_len, "null");
        return;
    };
    writeResult(result_buf, result_buf_len, json);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon-runtime\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
