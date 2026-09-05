// instance — a single-instance lock, keyed by the app's own name (Windows
// only for now; see instance_acquire's own doc comment in carbon_plugin.h
// and instance.rs's header for why macOS/Linux aren't stubbed out here
// rather than guessed at).
//
//   carbon plugin add instance
//
//   import { acquireSingleInstance } from "@carbon/plugins/instance";
//   acquireSingleInstance(); // call once, as early as possible
//
// `acquireSingleInstance()` MAY NOT RETURN AT ALL: if another instance of
// this app already holds the lock, the native call exits the process
// directly (matching deep-link's own "may not return" contract for
// forwarded launches — see its main.zig for the identical shape). When it
// DOES return, this is always the sole instance; there is no "already
// running, handle it in JS" branch to write, by construction.
//
//   zig build                  build it
//   carbon plugin add instance fetch + build + install into the current app
//   carbon plugin check        verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "instance",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:instance"},
    .exports = &.{.{ .name = "acquire" }},
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
    _ = app.setGlobalFunction("acquire", jsAcquire);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── acquire() → boolean ──────────────────────────────────────────────────
//
// Always returns `true` when it returns at all — see this file's own
// header comment for why there is no `false` case to observe. The app's
// own name (`app.raw.app_name`, same field deep-link's register() reads)
// is the lock key, not a JS-supplied argument: two launches of the SAME
// app should collide, two DIFFERENT apps should not, and app_name is
// already the value that distinguishes them.

fn jsAcquire(
    _: ?*sdk.RawJsContext,
    _: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const app = g_app orelse {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    };
    const app_id = app.raw.app_name;
    if (app_id == null) {
        writeBoolResult(result_buf, result_buf_len, false);
        return;
    }
    _ = app.instanceAcquire(@ptrCast(app_id));
    writeBoolResult(result_buf, result_buf_len, true);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"instance\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
