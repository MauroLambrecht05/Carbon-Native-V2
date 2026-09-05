// carbon-snapshot — reports whether this session's JS runtime was
// restored from a pre-built QuickJS heap snapshot (a cold-start
// optimization) rather than freshly evaluating the bundle from scratch.
// Not an OS or hosted-cloud capability, and NOT a pixel/screenshot
// capability despite the name — see carbon_plugin.h's ABI 1.23 doc
// comment for that naming note: the underlying mechanism is
// `solutions/capabilities/rendering/snapshot` (a QuickJS VM heap
// snapshot/restore), unrelated to screen capture (that's the
// `screencapture` plugin).
//
//   carbon plugin add carbon-snapshot
//
//   import { wasRestoredFromSnapshot } from "@carbon/plugins/carbon-snapshot";
//   if (wasRestoredFromSnapshot()) { /* cold-start was skipped */ }
//
//   zig build                         build it
//   carbon plugin add carbon-snapshot fetch + build + install into the app
//   carbon plugin check               verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "carbon-snapshot",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:carbon-snapshot"},
    .exports = &.{.{ .name = "wasRestoredFromSnapshot" }},
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
    _ = app.setGlobalFunction("wasRestoredFromSnapshot", jsWasRestoredFromSnapshot);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── wasRestoredFromSnapshot() → boolean ─────────────────────────────────

fn jsWasRestoredFromSnapshot(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    writeBoolResult(result_buf, result_buf_len, app.snapshotRestored());
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon-snapshot\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
