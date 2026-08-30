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
// declarations) explains why the four methods below (setGlobalString,
// setGlobalNumber, setGlobalFunction, eval) call through
// `self.raw.set_global_*`/`self.raw.eval` function pointers rather than
// resolving `carbon_js_*` symbols at load time: those pointers are ABI 1.1
// fields on `CarbonApp` itself, filled in by the host before
// `carbon_plugin_register` runs — the same shape `request_paint` and
// `push_event` already use — specifically so this SDK never needs
// GetProcAddress/GetModuleHandleW (or dlsym/RTLD_DEFAULT on POSIX) at all.
// The plugin trust checker (solutions/capabilities/plugin/trust) denies
// those two symbol families from a compiled plugin's import table
// unconditionally, for every module, because a plugin that can resolve one
// arbitrary OS symbol at runtime can resolve any of them — and every
// legitimate Carbon plugin calls at least one of these four, so an SDK that
// still resolved them dynamically would fail its own trust check by
// construction. This is not a workaround for the checker; it closes a real
// gap the checker's own design doc names: "no static import-table check
// means anything" once dynamic resolution is available at all.

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
        const f = self.raw.set_global_string orelse return CARBON_ERR_GENERIC;
        return f(ctx, name, value);
    }

    pub fn setGlobalNumber(self: CarbonApp, name: [*:0]const u8, value: f64) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.set_global_number orelse return CARBON_ERR_GENERIC;
        return f(ctx, name, value);
    }

    pub fn setGlobalFunction(self: CarbonApp, name: [*:0]const u8, cb: c.CarbonJSCallback) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.set_global_function orelse return CARBON_ERR_GENERIC;
        return f(ctx, name, cb);
    }

    pub fn eval(self: CarbonApp, source: [*:0]const u8) i32 {
        const ctx = self.raw.js_ctx orelse return CARBON_ERR_NO_CTX;
        const f = self.raw.eval orelse return CARBON_ERR_GENERIC;
        return f(ctx, source);
    }

    /// ABI 1.2. Load a TTF/OTF font from a filesystem path into the text
    /// engine, optionally registered under `family` so `font-family:
    /// "<family>"` in CSS/JSX selects this exact face afterward. Pass
    /// `null` for `family` to load anonymously (coverage-fallback only).
    /// `weight` is the CSS font-weight scale (1-1000; 0 = default 400) —
    /// load the same family at multiple weights for real bold/semibold
    /// instead of a fallback substitution. Runs synchronously — the return
    /// value is the real result, not a "queued" placeholder.
    pub fn loadFontPath(self: CarbonApp, path: [*:0]const u8, family: ?[*:0]const u8, weight: u32) i32 {
        const f = self.raw.load_font_path orelse return CARBON_ERR_GENERIC;
        return f(self.raw, path, family orelse null, weight);
    }

    /// Same as `loadFontPath`, from raw bytes already in memory (e.g. an
    /// app-bundled asset read by the plugin itself rather than resolved
    /// from a path on disk).
    pub fn loadFontBytes(self: CarbonApp, bytes: []const u8, family: ?[*:0]const u8, weight: u32) i32 {
        const f = self.raw.load_font_bytes orelse return CARBON_ERR_GENERIC;
        return f(self.raw, bytes.ptr, bytes.len, family orelse null, weight);
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
        \\{"name":"hello","version":"0.1.0","abi_version_major":1,"abi_version_minor":1,"capabilities":{"required":[],"optional":["fs.read"]},"modules":["carbon:hello"],"lifecycle_hooks":["register"]}
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
