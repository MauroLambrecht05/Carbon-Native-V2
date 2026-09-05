// menu — a native application menu bar (Windows only for now; see
// carbon_plugin.h's ABI 1.7 doc comment and the host-side menu.rs header
// for why macOS/Linux aren't stubbed out here rather than guessed at).
//
//   carbon plugin add menu
//
//   import { useMenu } from "@carbon/plugins/menu";
//   useMenu([
//     { label: "File", items: [
//       { id: "open", label: "Open" },
//       { separator: true },
//       { id: "quit", label: "Quit", accelerator: "Ctrl+Q" },
//     ] },
//   ], {
//     onSelect: (id) => console.log("menu:", id),
//   });
//
// Setting a new menu REPLACES the window's current one (unlike tray's
// `setup`, a second call is not a no-op) — Win32's SetMenu, which the host
// side calls internally, already does this correctly, including after HMR
// re-runs `carbon_plugin_after_reload` with the same menu.
//
// Event delivery reuses the push_event + JS-shim pattern from
// global-shortcuts/tray/deep-link — see tray's own main.zig for the full
// rationale. Selecting an item fires push_event("menu.click",
// "{\"id\":\"<id>\"}"), delivered via `carbon.on("menu.click", cb)`.
//
//   zig build              build it
//   carbon plugin add menu fetch + build + install into the current app
//   carbon plugin check    verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "menu",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:menu"},
    .exports = &.{.{ .name = "setup" }},
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
// rationale (same shim, `carbon.on`/`carbon.off`, guarded so a second
// plugin installing it is a no-op).
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
    _ = app.setGlobalFunction("setup", jsSetup);
}

fn writeBoolResult(buf: [*c]u8, cap: usize, v: bool) void {
    if (buf == null or cap == 0) return;
    const json = if (v) "true" else "false";
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── setup(menuSpec) → boolean ────────────────────────────────────────────
//
// `menuSpec` is the JS-side array documented in this file's header
// comment; it's re-serialized to JSON and passed through to
// `app.menuSetup` verbatim — the host side (menu.rs) does the real
// parsing, same division of labor as tray's `setup`.

fn jsSetup(
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
        const menu_value = args[0];

        // args[0] is already the top-level menu array — re-serialize it
        // as-is (not wrapped) since that's exactly the shape menu_setup's
        // menu_json parameter expects.
        const menu_json = std.json.Stringify.valueAlloc(allocator, menu_value, .{}) catch break :blk false;
        const menu_json_z = allocator.dupeZ(u8, menu_json) catch break :blk false;

        break :blk app.menuSetup(menu_json_z.ptr) == sdk.CARBON_OK;
    };
    writeBoolResult(result_buf, result_buf_len, ok);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and no stray capability" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"menu\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"required\":[]") != null);
}
