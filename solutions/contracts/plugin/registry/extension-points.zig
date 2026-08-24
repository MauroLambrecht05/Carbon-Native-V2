//! extension-points.zig — every place a Carbon plugin can plug in.
//!
//! ── THIS FILE IS THE SOURCE OF TRUTH ────────────────────────────────────────
//! The C header a plugin compiles against, the Rust table the host dispatches
//! through, and the TypeScript the toolchain validates manifests with are all
//! GENERATED from the array at the bottom of this file:
//!
//!     carbon ext generate
//!
//! and `//.tools/validation:workspace_test` fails if the checked-in renderings
//! stop agreeing with it. Edit this file; never edit the generated ones.
//!
//! ── WHY ZIG ─────────────────────────────────────────────────────────────────
//! Plugins are written in Zig, so the one language guaranteed to be present at
//! plugin-build time is Zig. A plugin `@import`s this file directly and gets
//! comptime-checked ids and signatures — the declaration is not a schema
//! describing the contract from outside, it IS the contract, and the plugin
//! side needs no generated code at all.
//!
//! The renderings exist because the other two parties cannot read Zig: the
//! runtime is Rust and the toolchain is TypeScript. Generating them is what
//! stops the three from drifting, which is exactly how the `__cm_*` boundary
//! next door went wrong before `check_host_boundary.py` existed.
//!
//! ── ADDING A POINT ──────────────────────────────────────────────────────────
//!   1. Append an entry to POINTS. Never reorder or remove — see STABILITY.
//!   2. Set `.since_minor` to the NEXT ABI minor, and bump
//!      CARBON_PLUGIN_ABI_VERSION_MINOR in
//!      products/carbon-ext/presentation/include/carbon_plugin.h.
//!   3. Run `carbon ext generate`.
//!   4. Call the new point from products/carbon — a declared point the runtime
//!      never dispatches is a promise to plugin authors that nothing keeps.
//!
//! ── STABILITY ───────────────────────────────────────────────────────────────
//! Plugins ship PREBUILT. A point's `symbol` is baked into a .dll on someone
//! else's disk, so:
//!
//!   * Removing a point, renaming its symbol, or changing its params is a MAJOR
//!     ABI break and invalidates every plugin that implements it.
//!   * Appending a point is a MINOR bump. Old plugins do not export it, the
//!     loader finds no symbol, and nothing happens — which is the correct
//!     behaviour and why every point is individually optional.
//!   * `.experimental` points may change within a major. The loader warns when
//!     a plugin implements one; that warning is the whole consent mechanism.

const std = @import("std");

// ── The vocabulary ──────────────────────────────────────────────────────────

/// How many plugins may implement one point.
pub const Arity = enum {
    /// Every plugin implementing it is called, in load order. The normal case:
    /// two plugins can both want a shutdown hook without conflicting.
    many,
    /// At most one plugin may implement it, because the result is a decision
    /// rather than a notification and two answers cannot be merged. The loader
    /// refuses the second claimant by name rather than silently picking one.
    exclusive,
};

/// What a plugin author may rely on.
pub const Stability = enum {
    /// Frozen for the life of the ABI major.
    stable,
    /// May change signature or disappear within a major. The loader logs a
    /// warning naming the plugin and the point.
    experimental,
};

/// The C types a point's parameters and return may use.
///
/// Deliberately tiny. Everything crossing this boundary is either a scalar, an
/// opaque host pointer, a UTF-8 string the host owns, or a raw byte span with
/// an explicit length — because anything richer would need an allocator
/// agreement, and the one place we have that (`app.alloc` / `app.free`) is for
/// buffers whose ownership genuinely transfers.
pub const ValueType = enum {
    /// `void` — a notification with no answer.
    void,
    /// `CarbonApp*` — the host descriptor. Every point takes this first.
    app,
    /// `uint32_t`.
    u32,
    /// `int32_t`, used for status returns (CARBON_OK / CARBON_ERR_*).
    i32,
    /// `bool` as `int32_t` — C89 has no bool and the ABI predates stdbool.
    boolean,
    /// `const char*`, UTF-8, NUL-terminated, owned by the HOST and valid only
    /// for the duration of the call. A plugin that needs it longer copies it.
    str,
    /// `uint8_t*` — a mutable byte span. Always followed by the length
    /// parameters the point documents; there is no implicit length.
    bytes_mut,
};

pub const Param = struct {
    name: []const u8,
    type: ValueType,
    doc: []const u8,
};

pub const ExtensionPoint = struct {
    /// Dot-separated, `<area>.<verb>`. This is what a plugin writes in its
    /// manifest's `extension_points` list and what the loader matches on.
    id: []const u8,

    /// The C symbol the plugin exports. Derived from the id by convention
    /// (`carbon_ext_<area>_<verb>`) but written out, because it is the thing
    /// baked into shipped binaries and it must be greppable.
    ///
    /// The seven points that predate this registry keep their original
    /// `carbon_plugin_*` names. Renaming them to match the convention would
    /// have been tidier and would have stopped every already-built plugin
    /// loading, which is the one cost this contract exists to avoid.
    symbol: []const u8,

    /// ABI MINOR version this point appeared in. A plugin built against a
    /// newer SDK than the runtime can check this and degrade.
    since_minor: u32,

    stability: Stability,
    arity: Arity,

    /// Capability the host app must grant in `[plugins.<name>] capabilities`
    /// before a plugin implementing this point will load. `null` means the
    /// point is unprivileged — it observes, and observing is not a permission.
    capability: ?[]const u8,

    /// Parameters AFTER the implicit `CarbonApp* app`, which every point takes
    /// first and none of them list.
    params: []const Param,

    returns: ValueType,

    /// When the host calls it. Rendered into every generated artifact, because
    /// "when does this run" is the question a plugin author actually has.
    dispatch: []const u8,

    doc: []const u8,
};

// ── The points ──────────────────────────────────────────────────────────────
//
// Order is load-bearing for humans only (the generated artifacts are keyed by
// id, not index), but it is grouped by area and append-ordered within a group
// so a diff reads as "what was added".

pub const POINTS = [_]ExtensionPoint{
    // ── lifecycle ───────────────────────────────────────────────────────────
    .{
        .id = "lifecycle.register",
        .symbol = "carbon_plugin_register",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Once, after the app bundle has been evaluated — so a plugin's globals shadow the app's rather than the other way round.",
        .doc =
        \\Install JS globals, start background threads, take the handles the
        \\plugin needs. The only point that is effectively required: a plugin
        \\exporting none of these does nothing.
        \\
        \\Runs AFTER the bundle. To install a global the app's own module-init
        \\code will see, use `lifecycle.before_bundle_eval` instead.
        \\
        \\Must not block. Heavy initialisation (opening an audio device,
        \\choosing a GPU adapter) belongs behind the first JS call that needs
        \\it.
        ,
    },
    .{
        .id = "lifecycle.before_bundle_eval",
        .symbol = "carbon_ext_lifecycle_before_bundle_eval",
        .since_minor = 1,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Immediately before each evaluation of the app bundle — the first one at startup, and every HMR re-evaluation after it.",
        .doc =
        \\The last moment at which a plugin can install a global the app's own
        \\module-init code will see. `lifecycle.register` runs earlier and is
        \\the right place for almost everything; this exists for globals that
        \\must shadow, or be shadowed by, the bundle.
        ,
    },
    .{
        .id = "lifecycle.before_reload",
        .symbol = "carbon_plugin_before_reload",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Before HMR re-evaluates the JS bundle.",
        .doc =
        \\Pause background threads and drop references to JS-owned values. The
        \\JS context survives a reload, but every global installed from
        \\`lifecycle.register` is about to be replaced.
        ,
    },
    .{
        .id = "lifecycle.after_reload",
        .symbol = "carbon_plugin_after_reload",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "After the new JS bundle has finished evaluating.",
        .doc =
        \\Re-install whatever `lifecycle.register` installed, and resume
        \\background threads. A plugin that implements `before_reload` and not
        \\this one has paused itself permanently.
        ,
    },
    .{
        .id = "lifecycle.shutdown",
        .symbol = "carbon_plugin_on_shutdown",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Once at exit, in REVERSE load order, before the library is unloaded.",
        .doc =
        \\Join threads and flush external state. After this returns the shared
        \\library is closed; a thread still running when that happens takes the
        \\process with it.
        ,
    },

    // ── paint ───────────────────────────────────────────────────────────────
    .{
        .id = "paint.before",
        .symbol = "carbon_plugin_before_paint",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = "paint.pixmap",
        .params = &.{
            .{ .name = "pixmap", .type = .bytes_mut, .doc = "RGBA8, row-major, top-left origin, premultiplied alpha. Valid only for this call." },
            .{ .name = "width", .type = .u32, .doc = "Pixels." },
            .{ .name = "height", .type = .u32, .doc = "Pixels." },
            .{ .name = "stride_bytes", .type = .u32, .doc = "Bytes per row. Usually width*4, but rows may be aligned — honour it." },
        },
        .returns = .void,
        .dispatch = "Every frame, after the rasterizer has drawn the scene and before the pixmap is presented.",
        .doc =
        \\Read or write pixels. A GPU plugin blits its offscreen target into
        \\the region belonging to its <canvas> node here.
        \\
        \\Capability-gated: a plugin that can write the framebuffer can draw
        \\anything anywhere, including over UI the user is about to click.
        ,
    },
    .{
        .id = "paint.after",
        .symbol = "carbon_plugin_after_paint",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Every frame, after present.",
        .doc =
        \\FPS counters, stats upload, frame pacing. The pixmap is gone by now —
        \\this point cannot see or touch pixels, which is why it needs no
        \\capability where `paint.before` does.
        ,
    },

    // ── window ──────────────────────────────────────────────────────────────
    .{
        .id = "window.resized",
        .symbol = "carbon_plugin_on_resize",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{
            .{ .name = "width", .type = .u32, .doc = "New width in logical pixels." },
            .{ .name = "height", .type = .u32, .doc = "New height in logical pixels." },
        },
        .returns = .void,
        .dispatch = "After the window resized and app->window_width/height were updated.",
        .doc =
        \\Resize swapchains and offscreen targets. The arguments repeat what is
        \\already on `app` — they are there so the common case needs no field
        \\access.
        ,
    },
    .{
        .id = "window.theme_changed",
        .symbol = "carbon_ext_window_theme_changed",
        .since_minor = 1,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{
            .{ .name = "is_dark", .type = .boolean, .doc = "1 when the OS reports a dark theme, 0 for light." },
        },
        .returns = .void,
        .dispatch = "When the OS theme changes, alongside the JS __cm_dispatch_theme_changed dispatch.",
        .doc =
        \\Re-theme anything the plugin draws itself. A plugin that only renders
        \\through JS does not need this — the app's own theme listener already
        \\covers it.
        ,
    },

    // ── host ────────────────────────────────────────────────────────────────
    .{
        .id = "host.resolve_asset",
        .symbol = "carbon_ext_host_resolve_asset",
        .since_minor = 1,
        .stability = .experimental,
        .arity = .exclusive,
        .capability = "fs.read",
        .params = &.{
            .{ .name = "request", .type = .str, .doc = "The specifier as written by the app, e.g. \"asset:sprites/hero.png\"." },
        },
        .returns = .i32,
        .dispatch = "NOT YET DISPATCHED — see the doc. Intended: when the runtime cannot resolve an asset specifier itself, before it reports a load failure.",
        .doc =
        \\NOT YET DISPATCHED. The loader binds this point and would call it,
        \\but products/carbon has no asset-resolution path to call it FROM —
        \\so a plugin implementing it today is never invoked.
        \\
        \\Declared anyway, as a deliberate compromise rather than an
        \\oversight: it is the only point exercising `exclusive` arity and a
        \\non-void return, so removing it would leave both untested end to
        \\end. It is `.experimental`, the loader warns on use, and this
        \\paragraph appears in all three generated artifacts.
        \\
        \\Wire it or remove it before ABI 1.1 ships.
        \\
        \\Answer where an asset lives. Exclusive because resolution is a
        \\decision: two plugins returning different paths for one specifier
        \\have no correct merge, so the loader refuses the second claimant
        \\rather than letting load order decide.
        \\
        \\Return CARBON_OK when handled, CARBON_ERR_GENERIC to decline and let
        \\the runtime carry on failing.
        \\
        \\Experimental: the resolved path is returned through a host call
        \\rather than an out-parameter, and that shape is not settled.
        ,
    },
};

// ── Compile-time invariants ─────────────────────────────────────────────────
//
// These run when a plugin `@import`s this file, so a malformed registry breaks
// the plugin build too, not only the generator. The generator re-checks them
// anyway: it has to parse this file rather than execute it, and a check that
// exists in only one of the two places is a check that eventually disagrees.

comptime {
    for (POINTS, 0..) |point, i| {
        if (point.id.len == 0) @compileError("extension point with an empty id");
        if (point.symbol.len == 0) @compileError("extension point '" ++ point.id ++ "' has no symbol");
        if (point.doc.len == 0) @compileError("extension point '" ++ point.id ++ "' has no doc");

        // Ids and symbols are both matched by string at load time; a duplicate
        // of either means one plugin's implementation silently answers for
        // another's point.
        for (POINTS[i + 1 ..]) |other| {
            if (std.mem.eql(u8, point.id, other.id)) {
                @compileError("duplicate extension point id: " ++ point.id);
            }
            if (std.mem.eql(u8, point.symbol, other.symbol)) {
                @compileError("duplicate extension point symbol: " ++ point.symbol);
            }
        }
    }
}

/// Look a point up by id at comptime. The SDK's `implement` helper uses this
/// so a plugin naming a point that does not exist fails to compile rather than
/// exporting a symbol nothing ever calls.
pub fn find(comptime id: []const u8) ?ExtensionPoint {
    for (POINTS) |point| {
        if (std.mem.eql(u8, point.id, id)) return point;
    }
    return null;
}

test "every point is discoverable by its own id" {
    // find()'s id is comptime by design (the SDK's plugin-side comptime
    // check calls it that way) — inline for to keep `point.id` comptime
    // here too, not a plain for's runtime-copied loop variable.
    inline for (POINTS) |point| {
        try std.testing.expect(find(point.id) != null);
    }
    try std.testing.expect(find("nope.missing") == null);
}
