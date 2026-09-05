// notify — a desktop toast through the OS notification centre. Plugin name
// "notify"; installs the "carbon:notification" JS module (unchanged from
// before this plugin's own folder/install-name was shortened).
//
// Moves notifications out of carbon-mini's always-on ambient
// `__cm_notification_send` global and into an explicit, opt-in plugin:
//
//   carbon plugin add notify
//
//   import { send } from "@carbon/plugins/notification";
//   send("Build complete", "Your app is ready.");
//
// Notifications fire-and-forget — the user dismisses them via the OS, not
// the app. No click callbacks (see the note on this in
// solutions/infrastructure/plugin-host/native/notification.rs).
//
//   zig build                  build it
//   carbon plugin add notify   fetch + build + install into the app
//   carbon plugin check        verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "notify",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:notification"},
    .exports = &.{.{ .name = "send" }},
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

// ── lifecycle.register / lifecycle.after_reload ─────────────────────────────
//
// `pub`, not a bare `fn`: see sdk.ext.implement's doc comment — a static
// release build's generated umbrella reaches these through `@import`, which
// only works for `pub` declarations.

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
    _ = app.setGlobalFunction("send", jsSend);
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

// ── send(title, body, icon?) → boolean ──────────────────────────────────────

fn jsSend(
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
        if (args_json == null) break :blk false;
        const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
        const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch break :blk false;
        const args = switch (parsed.value) {
            .array => |a| a.items,
            else => break :blk false,
        };
        if (args.len < 2) break :blk false;
        const title = switch (args[0]) {
            .string => |s| s,
            else => break :blk false,
        };
        const body = switch (args[1]) {
            .string => |s| s,
            else => break :blk false,
        };
        const icon: []const u8 = if (args.len > 2) switch (args[2]) {
            .string => |s| s,
            else => "",
        } else "";
        const title_z = allocator.dupeZ(u8, title) catch break :blk false;
        const body_z = allocator.dupeZ(u8, body) catch break :blk false;
        const icon_z = allocator.dupeZ(u8, icon) catch break :blk false;
        break :blk app.notificationSend(title_z.ptr, body_z.ptr, icon_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"notify\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
