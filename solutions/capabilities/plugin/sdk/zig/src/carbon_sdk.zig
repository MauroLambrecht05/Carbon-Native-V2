// carbon_sdk.zig — Zig wrappers around the Carbon plugin C ABI.
//
// Most plugin authors only need:
//   * `CarbonApp` (the host descriptor)
//   * `manifest.build` (the manifest, composed at comptime)
//   * `ext.expect` (comptime-check an extension point id)
//   * `setGlobalString` / `setGlobalNumber` / `setGlobalFunction` helpers
//   * `pushEvent` for cross-thread events
//
// The C ABI itself is in `../include/carbon_plugin.h`. We re-import it via
// @cInclude inside this module so the constants stay in lockstep.
//
// The EXTENSION POINTS — what a plugin can actually plug into — are in
// `extension_points.zig`, which re-exports
// `contracts/plugin/registry/extension-points.zig` verbatim. A plugin author
// reading that file is reading the same declaration the runtime's dispatch
// table was generated from.

const std = @import("std");
const builtin = @import("builtin");

/// The extension-point registry, and the comptime helpers that check an id.
pub const ext = @import("extension_points.zig");

/// The comptime manifest builder.
pub const manifest = @import("manifest.zig");

/// Cross-thread event helpers.
pub const push = @import("push.zig");

pub const c = @cImport({
    @cInclude("carbon_plugin.h");
});

pub const ABI_VERSION_MAJOR: u32 = c.CARBON_PLUGIN_ABI_VERSION_MAJOR;
pub const ABI_VERSION_MINOR: u32 = c.CARBON_PLUGIN_ABI_VERSION_MINOR;

pub const CARBON_OK: i32 = c.CARBON_OK;
pub const CARBON_ERR_GENERIC: i32 = c.CARBON_ERR_GENERIC;
pub const CARBON_ERR_INVALID: i32 = c.CARBON_ERR_INVALID;
pub const CARBON_ERR_QUEUE_FULL: i32 = c.CARBON_ERR_QUEUE_FULL;
pub const CARBON_ERR_NO_CTX: i32 = c.CARBON_ERR_NO_CTX;

/// Re-export the raw C struct so plugins that need to dereference fields
/// directly can do so. Most should prefer the helpers below.
pub const RawApp = c.CarbonApp;
pub const RawJsContext = c.CarbonJSContext;

// carbon_plugin.h's "RESOLUTION MODEL" comment (above the carbon_js_*
// declarations) is the contract this section implements: those symbols are
// exported by the carbon-mini/carbon-blitz HOST executable
// (products/carbon/build.rs emits the /EXPORT: linker args on Windows,
// -rdynamic elsewhere), not linked by a plugin — there is no host .exe on
// disk for a plugin to link against when it builds standalone. Calling them
// through @cImport's plain `extern "c"` declarations instead makes the
// PLUGIN's own linker demand them at build time, which fails with
// "undefined symbol" (confirmed building labs/clipboard-plugin before this
// fix). They have to be resolved at LOAD time, once the plugin DLL is
// inside the host process — GetProcAddress on Windows, dlsym elsewhere —
// looked up once and cached, exactly as the header says the SDK should.
fn resolveHostSymbol(comptime name: [:0]const u8) *anyopaque {
    return switch (builtin.os.tag) {
        .windows => blk: {
            const k32 = std.os.windows.kernel32;
            const module = k32.GetModuleHandleW(null) orelse
                @panic("carbon plugin: could not get a handle to the host process");
            const proc = k32.GetProcAddress(module, name) orelse
                @panic("carbon plugin: host process does not export " ++ name ++
                    " — was it built without the /EXPORT linker args in products/carbon/build.rs?");
            break :blk @as(*anyopaque, @ptrCast(proc));
        },
        else => blk: {
            // RTLD_DEFAULT isn't exposed by Zig's std.c. glibc/musl define
            // it as NULL; Darwin's dlfcn.h defines it as -2 — fixed,
            // documented per-platform values, not something to guess.
            const rtld_default: ?*anyopaque = if (builtin.target.isDarwin())
                @ptrFromInt(@as(usize, @bitCast(@as(isize, -2))))
            else
                null;
            break :blk std.c.dlsym(rtld_default, name) orelse
                @panic("carbon plugin: host process does not export " ++ name ++
                    " — was it built with -rdynamic (see products/carbon/build.rs)?");
        },
    };
}

const SetGlobalStringFn = *const fn (*c.CarbonJSContext, [*:0]const u8, [*:0]const u8) callconv(.C) i32;
const SetGlobalNumberFn = *const fn (*c.CarbonJSContext, [*:0]const u8, f64) callconv(.C) i32;
const SetGlobalFunctionFn = *const fn (*c.CarbonJSContext, [*:0]const u8, c.CarbonJSCallback) callconv(.C) i32;
const EvalFn = *const fn (*c.CarbonJSContext, [*:0]const u8) callconv(.C) i32;

var set_global_string_fn: ?SetGlobalStringFn = null;
var set_global_number_fn: ?SetGlobalNumberFn = null;
var set_global_function_fn: ?SetGlobalFunctionFn = null;
var eval_fn: ?EvalFn = null;

fn resolved(comptime T: type, cache: *?T, comptime name: [:0]const u8) T {
    if (cache.*) |f| return f;
    const f: T = @ptrCast(@alignCast(resolveHostSymbol(name)));
    cache.* = f;
    return f;
}

/// A safe-ish view over a `*c.CarbonApp` pointer. Construct one inside
/// each entry point with `CarbonApp.fromRaw(app)`.
pub const CarbonApp = struct {
    raw: *c.CarbonApp,

    pub fn fromRaw(raw: *c.CarbonApp) CarbonApp {
        return .{ .raw = raw };
    }

    pub fn abiVersion(self: CarbonApp) struct { major: u32, minor: u32 } {
        return .{ .major = self.raw.abi_version_major, .minor = self.raw.abi_version_minor };
    }

    pub fn abiCompatible(self: CarbonApp) bool {
        return self.raw.abi_version_major == ABI_VERSION_MAJOR;
    }

    pub fn windowSize(self: CarbonApp) struct { w: u32, h: u32 } {
        return .{ .w = self.raw.window_width, .h = self.raw.window_height };
    }

    pub fn jsContext(self: CarbonApp) ?*c.CarbonJSContext {
        return self.raw.js_ctx;
    }

    pub fn requestPaint(self: CarbonApp) void {
        if (self.raw.request_paint) |f| f(self.raw);
    }

    pub fn pushEvent(self: CarbonApp, name: [*:0]const u8, json_payload: [*:0]const u8) i32 {
        const f = self.raw.push_event orelse return CARBON_ERR_INVALID;
        return f(self.raw, name, json_payload);
    }

    pub fn setGlobalString(self: CarbonApp, name: [*:0]const u8, value: [*:0]const u8) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = resolved(SetGlobalStringFn, &set_global_string_fn, "carbon_js_set_global_string");
        return f(ctx, name, value);
    }

    pub fn setGlobalNumber(self: CarbonApp, name: [*:0]const u8, value: f64) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = resolved(SetGlobalNumberFn, &set_global_number_fn, "carbon_js_set_global_number");
        return f(ctx, name, value);
    }

    pub fn setGlobalFunction(self: CarbonApp, name: [*:0]const u8, cb: c.CarbonJSCallback) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = resolved(SetGlobalFunctionFn, &set_global_function_fn, "carbon_js_set_global_function");
        return f(ctx, name, cb);
    }

    pub fn eval(self: CarbonApp, source: [*:0]const u8) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = resolved(EvalFn, &eval_fn, "carbon_js_eval");
        return f(ctx, source);
    }
};

/// Compose a manifest JSON string at comptime.
///
/// DEPRECATED — use `manifest.build`, which derives the capability list from
/// the extension points the plugin declares instead of asking the author to
/// keep the two in agreement by hand. Kept because plugins written against
/// ABI 1.0 call it, and it still produces a manifest the loader accepts.
pub fn buildManifestJson(comptime cfg: ManifestConfig) []const u8 {
    @setEvalBranchQuota(10_000);
    return std.fmt.comptimePrint(
        \\{{"name":"{s}","version":"{s}","abi_version_major":{d},"abi_version_minor":{d},"capabilities":{{"required":{s},"optional":{s}}},"modules":{s},"lifecycle_hooks":{s}}}
    , .{
        cfg.name,
        cfg.version,
        cfg.abi_version_major,
        cfg.abi_version_minor,
        jsonStringArray(cfg.required),
        jsonStringArray(cfg.optional),
        jsonStringArray(cfg.modules),
        jsonStringArray(cfg.hooks),
    });
}

pub const ManifestConfig = struct {
    name: []const u8,
    version: []const u8,
    abi_version_major: u32 = ABI_VERSION_MAJOR,
    abi_version_minor: u32 = ABI_VERSION_MINOR,
    required: []const []const u8 = &.{},
    optional: []const []const u8 = &.{},
    modules: []const []const u8 = &.{},
    hooks: []const []const u8 = &.{},
};

fn jsonStringArray(comptime arr: []const []const u8) []const u8 {
    if (arr.len == 0) return "[]";
    comptime var out: []const u8 = "[";
    inline for (arr, 0..) |s, i| {
        if (i > 0) out = out ++ ",";
        out = out ++ "\"" ++ s ++ "\"";
    }
    out = out ++ "]";
    return out;
}

test "the deprecated manifest builder still produces what the loader parses" {
    const want =
        \\{"name":"hello","version":"0.1.0","abi_version_major":1,"abi_version_minor":0,"capabilities":{"required":[],"optional":["fs.read"]},"modules":["carbon:hello"],"lifecycle_hooks":["register"]}
    ;
    const got = comptime buildManifestJson(.{
        .name = "hello",
        .version = "0.1.0",
        .optional = &.{"fs.read"},
        .modules = &.{"carbon:hello"},
        .hooks = &.{"register"},
    });
    try std.testing.expectEqualStrings(want, got);
}
