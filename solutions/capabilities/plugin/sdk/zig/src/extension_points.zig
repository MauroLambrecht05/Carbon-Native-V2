// The extension-point registry, re-exported, plus the one helper that makes
// implementing a point safe to get wrong.
//
// ── NOTHING HERE IS GENERATED ───────────────────────────────────────────────
// The C header and the Rust table are generated because C and Rust cannot read
// the registry. Zig can: this file `@import`s
// `contracts/plugin/registry/extension-points.zig` directly, so a plugin gets
// the ids and the metadata from the SAME FILE the runtime's table was rendered
// from, with no intermediate copy to drift.
//
// That is the concrete payoff of the answer to "what language are extension
// points written in", and it is why the SDK ships one language.

const std = @import("std");

/// The registry itself. `registry.POINTS` is every point; `registry.find(id)`
/// resolves one at comptime.
pub const registry = @import("carbon_extension_points");

pub const ExtensionPoint = registry.ExtensionPoint;
pub const Arity = registry.Arity;
pub const Stability = registry.Stability;
pub const ValueType = registry.ValueType;
pub const POINTS = registry.POINTS;

/// The ABI minor this SDK's registry implies — the highest `since_minor` in
/// it. A plugin can compare it against `app.abiVersion().minor` to find out
/// whether the runtime it landed on is older than the SDK it was built with.
pub const REGISTRY_MINOR: u32 = blk: {
    var highest: u32 = 0;
    for (POINTS) |point| {
        if (point.since_minor > highest) highest = point.since_minor;
    }
    break :blk highest;
};

/// Assert at comptime that `id` names a real extension point, and hand back
/// its spec.
///
/// Use it beside every `export fn`:
///
///     comptime { _ = ext.expect("paint.before"); }
///     export fn carbon_plugin_before_paint(...) callconv(.c) void { ... }
///
/// A misspelled id then fails the plugin build with the list of real ones,
/// rather than producing a shared library that loads, exports a symbol nothing
/// resolves, and silently never runs. That failure mode is the single most
/// common thing to get wrong when writing a plugin, because the export
/// compiles perfectly.
pub fn expect(comptime id: []const u8) ExtensionPoint {
    comptime {
        return registry.find(id) orelse @compileError(
            "no extension point '" ++ id ++ "'. Known points:" ++ idList(),
        );
    }
}

/// The exported symbol a point requires, as a comptime string.
///
/// Zig cannot name an `export fn` from a comptime value, so this does not
/// generate the export — it exists so a plugin can assert that the name it
/// typed is the name the registry expects:
///
///     comptime {
///         std.debug.assert(std.mem.eql(u8, symbolOf("paint.before"),
///                                      "carbon_plugin_before_paint"));
///     }
pub fn symbolOf(comptime id: []const u8) []const u8 {
    return expect(id).symbol;
}

/// Does this point need a capability the host app has to grant?
///
/// A plugin can use it to shape its own manifest, so the `required` list and
/// the points it implements cannot disagree.
pub fn capabilityOf(comptime id: []const u8) ?[]const u8 {
    return expect(id).capability;
}

fn idList() []const u8 {
    comptime {
        var out: []const u8 = "";
        for (POINTS) |point| out = out ++ "\n  " ++ point.id;
        return out;
    }
}

test "expect resolves every declared point" {
    inline for (POINTS) |point| {
        const found = comptime expect(point.id);
        try std.testing.expectEqualStrings(point.symbol, found.symbol);
    }
}

test "REGISTRY_MINOR is the highest since_minor" {
    for (POINTS) |point| {
        try std.testing.expect(point.since_minor <= REGISTRY_MINOR);
    }
}
