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

/// Whether we're compiling for a real standalone dynamic library (one
/// plugin, dlopen'd — the only mode that existed before static release
/// linking) or as a module `@import`ed into a generated umbrella for a
/// statically-linked release binary. Set by the product composition root
/// (`products/carbon-ext/composition/build.zig`'s `-Dplugin-linkage`),
/// exposed here as a plain build-options module. Defaults to `.dynamic`, so
/// every plugin's OWN standalone `build.zig` (and `carbon dev`'s whole
/// pipeline) is completely unaffected unless something deliberately asks for
/// `.static`.
const linkage = @import("carbon_plugin_linkage");
// `std.Build.Step.Options.addOption` re-synthesizes an equivalent enum type
// into the generated module rather than exporting the build.zig one under
// its original name — `@TypeOf(linkage.mode)` gets that synthesized type
// without needing to know what it's called.
pub const LinkageMode = @TypeOf(linkage.mode);
pub const linkage_mode: LinkageMode = linkage.mode;

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

/// Implement extension point `id` with `func`.
///
/// Replaces the old hand-written pattern of a `comptime { _ = ext.expect(id); }`
/// assertion next to a manually-named `export fn` — this does the same
/// validation AND decides, from `linkage_mode`, whether `func` becomes a real
/// exported C symbol at all:
///
///   * `.dynamic` (standalone `zig build`, `carbon dev`'s whole pipeline):
///     exports `func` under the point's registry symbol, exactly as a
///     hand-written `export fn <symbol>` did before this existed. A
///     standalone plugin's `.dll`/`.so`/`.dylib` is byte-for-byte the same
///     shape as before.
///   * `.static` (compiled as one plugin among several `@import`ed into a
///     generated release umbrella): exports nothing. `func` stays an
///     ordinary Zig function the umbrella calls directly through its
///     `@import` of this module — which is exactly why `func` MUST be
///     declared `pub fn`, never a bare `fn`: dynamic mode doesn't need `pub`
///     (the symbol leaves through `@export`, not through Zig's own module
///     visibility), but static mode has no other way out of the module.
///
/// `func`'s signature is asserted against nothing here beyond what
/// `@export`'s own type-checking already enforces when linkage is dynamic —
/// same as the code this replaces, which relied on `export fn`'s signature
/// being written out by hand to match the registry's documented shape.
pub fn implement(comptime id: []const u8, comptime func: anytype) void {
    const point = expect(id);
    if (linkage_mode == .dynamic) {
        @export(&func, .{ .name = point.symbol, .linkage = .strong });
    }
}

/// Same idea as `implement`, for `carbon_plugin_manifest` — every plugin's
/// required manifest getter, which sits outside `POINTS` (it is how a
/// dynamically-loaded plugin gets asked what it is, BEFORE the loader knows
/// anything else about it) so `implement`'s registry lookup doesn't apply to
/// it. A statically-linked plugin needs no runtime-queryable manifest at all
/// — the build-time tooling that assembled the umbrella already validated
/// capabilities/ABI/points against this exact `carbon-plugin.toml` before
/// generating it — so `.static` mode exports nothing here either, and the
/// umbrella never re-declares `carbon_plugin_manifest` on its plugins' behalf.
pub fn implementManifest(comptime func: anytype) void {
    if (linkage_mode == .dynamic) {
        @export(&func, .{ .name = "carbon_plugin_manifest", .linkage = .strong });
    }
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
