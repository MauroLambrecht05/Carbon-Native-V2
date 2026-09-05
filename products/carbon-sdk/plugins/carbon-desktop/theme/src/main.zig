// theme — accent color, high-contrast, and reduced-motion preference
// detection (Windows only for now; see theme_query's own doc comment in
// carbon_plugin.h and the host-side theme.rs header for why macOS/Linux
// aren't stubbed out here rather than guessed at).
//
//   carbon plugin add theme
//
//   import { queryThemePrefs } from "@carbon/plugins/theme";
//   const { accentColor, highContrast, reducedMotion } = queryThemePrefs();
//
// A point-in-time query, not a subscription — live light/dark theme
// changes and window-focus changes are already ambient (the Solid
// renderer's `onThemeChange`/`onWindowFocus`) and don't need a plugin;
// re-call this after one of those fires if you want the other three
// preferences to stay live too.
//
//   zig build              build it
//   carbon plugin add theme fetch + build + install into the current app
//   carbon plugin check    verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "theme",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:theme"},
    .exports = &.{.{ .name = "queryThemePrefs" }},
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
    _ = app.setGlobalFunction("queryThemePrefs", jsQueryThemePrefs);
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── queryThemePrefs() → {accentColor, highContrast, reducedMotion} | null ──

fn jsQueryThemePrefs(
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
    const ptr = app.themeQuery(&status);
    defer app.freeString(ptr);
    if (status != sdk.CARBON_OK or ptr == null) {
        writeResult(result_buf, result_buf_len, "null");
        return;
    }
    // Already a JSON object from the host side — passed through as-is,
    // not re-quoted, same convention as dialog's openFiles.
    writeResult(result_buf, result_buf_len, std.mem.span(ptr));
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"theme\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
