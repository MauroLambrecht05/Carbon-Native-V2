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

/// One JS-facing function a plugin's module (e.g. `carbon:clipboard`)
/// exports. `name` is what app code imports (`import { X } from
/// "carbon:thing"`); `global` is the globalThis property it reads at
/// call time, if different from `name` — needed when `name` collides
/// with a reserved word (`delete`) or with another plugin's own export
/// of the same common name (`register`), since every plugin's globals
/// live in the SAME globalThis namespace at runtime.
pub const Export = struct {
    name: []const u8,
    global: ?[]const u8 = null,
};

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
    /// used by `carbon plugin info`, not enforced. `exports` (below) is
    /// keyed to `modules[0]` — every carbon-sdk plugin so far has exactly
    /// one module, so this stays a single list rather than a per-module map
    /// until a real multi-module plugin needs otherwise.
    modules: []const []const u8 = &.{},

    /// What `modules[0]` exports to app code. This is the ONE piece of a
    /// plugin's manifest the runtime's embedded JSON never carries (a JS
    /// bundler needs it to generate lazy wrappers at BUILD time, without
    /// loading any native code — see toToml's doc comment) — declaring it
    /// here, alongside everything else, is what lets carbon-plugin.toml be
    /// generated instead of hand-duplicated.
    exports: []const Export = &.{},

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
///     export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
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

/// carbon-plugin.toml's content, generated from the SAME `Config` that
/// produces the runtime manifest via `build()` above — the two can no
/// longer drift, because there is only one authored source between them.
///
/// `carbon plugin add <name>` (and `carbon plugin install`/`list`) read
/// the FILE this produces, not the compiled plugin, because they need to
/// know a plugin's exports (for the JS bundler's lazy-wrapper codegen —
/// see @carbon/vite/imports) without loading native code, which a bundler
/// running on an app that merely IMPORTS a plugin's module cannot do. The
/// runtime's own `carbon_plugin_manifest()` (built by `build()`, above)
/// is the loader's actual source of truth once a plugin is really
/// loaded; this file is a static projection of the same config for
/// tooling that runs before or without that.
///
/// Each plugin exposes this via `zig build gen-manifest` (see
/// clipboard's build.zig/src/genmanifest.zig for the pattern: a tiny
/// helper executable prints this, a Run step captures its output, and
/// `b.addUpdateSourceFiles` writes it back to carbon-plugin.toml) — run
/// that after changing a plugin's `CFG` instead of hand-editing the TOML.
/// (An automatic `zig build test`-time drift check was the first design
/// here; dropped after `@embedFile`/anonymous-import of a non-.zig file
/// outside a module's own src/ didn't resolve cleanly under Zig 0.16's
/// module sandboxing — regeneration-on-demand was the reliable fallback.)
pub fn toToml(comptime cfg: Config) []const u8 {
    comptime {
        @setEvalBranchQuota(200_000);

        var out: []const u8 = std.fmt.comptimePrint(
            \\# GENERATED — do not hand-edit. Source of truth is the `CFG`
            \\# config in src/main.zig; run `zig build gen-manifest` after
            \\# changing it. See manifest.zig's `toToml` doc comment for why
            \\# this file exists at all alongside that config.
            \\name = "{s}"
            \\version = "{s}"
            \\language = "zig"
            \\
            \\extension-points = {s}
            \\modules = {s}
            \\
        , .{ cfg.name, cfg.version, jsonArray(cfg.points), jsonArray(cfg.modules) });

        if (cfg.exports.len > 0) {
            const module = if (cfg.modules.len > 0) cfg.modules[0] else cfg.name;
            out = out ++ std.fmt.comptimePrint(
                \\
                \\[exports."{s}"]
                \\names = {s}
                \\
            , .{ module, jsonArray(exportNames(cfg.exports)) });
            const globals = exportGlobalsToml(cfg.exports);
            if (globals.len > 0) {
                out = out ++ std.fmt.comptimePrint(
                    \\[exports."{s}".globals]
                    \\{s}
                    \\
                , .{ module, globals });
            }
        }

        out = out ++ std.fmt.comptimePrint(
            \\
            \\[abi]
            \\major = {d}
            \\minor = {d}
            \\
            \\[capabilities]
            \\required = {s}
            \\optional = {s}
            \\
        , .{
            cfg.abi_version_major,
            cfg.abi_version_minor,
            jsonArray(requiredCapabilities(cfg)),
            jsonArray(cfg.optional),
        });

        return out;
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

fn exportNames(comptime exports: []const Export) []const []const u8 {
    comptime {
        var out: []const []const u8 = &.{};
        for (exports) |exp| out = out ++ &[_][]const u8{exp.name};
        return out;
    }
}

fn exportGlobalsToml(comptime exports: []const Export) []const u8 {
    comptime {
        var out: []const u8 = "";
        for (exports) |exp| {
            const g = exp.global orelse continue;
            out = out ++ std.fmt.comptimePrint("{s} = \"{s}\"\n", .{ exp.name, g });
        }
        return out;
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
