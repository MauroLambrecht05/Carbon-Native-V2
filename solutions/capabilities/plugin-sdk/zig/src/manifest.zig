// Building the manifest JSON a plugin returns from `carbon_plugin_manifest`.
//
// The manifest is how a plugin describes itself BEFORE any of its code runs:
// the loader parses it, checks the ABI major and the capability grants, and
// only then binds symbols. So it has to be a static string with a stable
// address, which is what `comptime` gives us for free.
//
// ── WHY IT DERIVES THE CAPABILITY LIST ──────────────────────────────────────
// A plugin declaring `.points = &.{"paint.before"}` needs the `paint.pixmap`
// capability, because that is what the registry says `paint.before` gates on.
// Making the author write both is an invitation to write one — and the loader
// then refuses to load a plugin whose own manifest contradicts the points it
// exports.
//
// So `required` is the union of what the author asked for and what their
// points imply, computed at comptime from the registry.

const std = @import("std");
const ext = @import("extension_points.zig");

pub const Config = struct {
    name: []const u8,
    version: []const u8,

    /// Extension point ids this plugin implements. Every one is checked
    /// against the registry at comptime.
    points: []const []const u8 = &.{},

    /// Capabilities beyond the ones the points imply — for anything the
    /// plugin does that is not an extension point, such as its own file or
    /// network access.
    required: []const []const u8 = &.{},
    optional: []const []const u8 = &.{},

    /// JS module names the plugin installs, e.g. `carbon:audio`. Advisory:
    /// used by `carbon plugin info`, not enforced.
    modules: []const []const u8 = &.{},

    abi_version_major: u32 = 1,
    abi_version_minor: u32 = ext.REGISTRY_MINOR,
};

/// The manifest as a NUL-terminated JSON string, built at comptime.
///
///     const MANIFEST = sdk.manifest.build(.{
///         .name = "my-thing",
///         .version = "0.1.0",
///         .points = &.{ "lifecycle.register", "paint.before" },
///     });
///
///     export fn carbon_plugin_manifest() callconv(.C) [*:0]const u8 {
///         return MANIFEST;
///     }
pub fn build(comptime cfg: Config) [*:0]const u8 {
    comptime {
        @setEvalBranchQuota(20_000);

        // Fails the build on a misspelled id, before it can become a plugin
        // that loads and does nothing.
        for (cfg.points) |id| _ = ext.expect(id);

        const json = std.fmt.comptimePrint(
            \\{{"name":"{s}","version":"{s}","abi_version_major":{d},"abi_version_minor":{d},"capabilities":{{"required":{s},"optional":{s}}},"modules":{s},"extension_points":{s}}}
        , .{
            cfg.name,
            cfg.version,
            cfg.abi_version_major,
            cfg.abi_version_minor,
            jsonArray(requiredCapabilities(cfg)),
            jsonArray(cfg.optional),
            jsonArray(cfg.modules),
            jsonArray(cfg.points),
        });

        return (json ++ &[_]u8{0})[0..json.len :0];
    }
}

/// What the author asked for, plus what their points imply, deduplicated.
fn requiredCapabilities(comptime cfg: Config) []const []const u8 {
    comptime {
        var out: []const []const u8 = cfg.required;

        for (cfg.points) |id| {
            const capability = ext.capabilityOf(id) orelse continue;
            if (!contains(out, capability)) out = out ++ &[_][]const u8{capability};
        }
        return out;
    }
}

fn contains(comptime haystack: []const []const u8, comptime needle: []const u8) bool {
    comptime {
        for (haystack) |item| {
            if (std.mem.eql(u8, item, needle)) return true;
        }
        return false;
    }
}

fn jsonArray(comptime items: []const []const u8) []const u8 {
    comptime {
        if (items.len == 0) return "[]";
        var out: []const u8 = "[";
        for (items, 0..) |item, i| {
            if (i > 0) out = out ++ ",";
            out = out ++ "\"" ++ item ++ "\"";
        }
        return out ++ "]";
    }
}

test "a manifest with no points" {
    const got = std.mem.span(build(.{ .name = "hello", .version = "0.1.0" }));
    try std.testing.expect(std.mem.indexOf(u8, got, "\"name\":\"hello\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, got, "\"extension_points\":[]") != null);
}

test "a point's capability lands in required without being asked for" {
    const got = std.mem.span(build(.{
        .name = "painter",
        .version = "0.1.0",
        .points = &.{"paint.before"},
    }));
    // paint.before gates on paint.pixmap; the author never wrote it.
    try std.testing.expect(std.mem.indexOf(u8, got, "\"paint.pixmap\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, got, "\"extension_points\":[\"paint.before\"]") != null);
}

test "an author-declared capability is not duplicated by the point that implies it" {
    const got = std.mem.span(build(.{
        .name = "painter",
        .version = "0.1.0",
        .points = &.{"paint.before"},
        .required = &.{"paint.pixmap"},
    }));
    try std.testing.expect(std.mem.indexOf(u8, got, "\"required\":[\"paint.pixmap\"]") != null);
}
