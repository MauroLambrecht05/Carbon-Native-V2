// build.zig — the Carbon plugin SDK, as a Zig package.
//
// This is the composition root of the SDK: the one file that names every piece
// and wires them together. A plugin author's build.zig does
// `b.dependency("carbon-plugin-sdk", .{})` and then
// `sdk.module("carbon_sdk")`, and this is what answers.
//
// ── WHAT IT COMPOSES ────────────────────────────────────────────────────────
//   ../presentation/include/           the C ABI an author compiles against
//   ../../../solutions/capabilities/plugin/sdk/zig/src/
//                                      the SDK's implementation — CarbonApp,
//                                      the comptime manifest builder, the
//                                      extension-point helpers
//   ../../../solutions/contracts/plugin/registry/
//                                      the extension-point declaration itself
//
// The product holds the surface and the wiring; the details are solutions. So
// the paths below reach outward, and that direction is the right one: a
// product composes solutions, and solutions never reach back.

const std = @import("std");

/// Whether a plugin's extension-point functions are real, globally-exported
/// C symbols (`.dynamic`, the default — one plugin per .dll/.so/.dylib,
/// dlopen'd at runtime) or plain module-scoped Zig functions (`.static` — no
/// export at all, meant to be called directly through a generated umbrella
/// module that `@import`s several plugins into one statically-linked release
/// binary). See `sdk.ext.implement`/`implementManifest` in
/// extension_points.zig, which is what actually branches on this.
///
/// A plugin's OWN build.zig never sets this directly — the app-level release
/// build tooling passes `.plugin_linkage = .static` into every enabled
/// plugin's `b.dependency("carbon-plugin-sdk", .{...})` call when generating
/// the umbrella; every plugin's standalone build.zig (unchanged, still
/// `.linkage = .dynamic`) and `carbon dev`'s per-plugin pipeline never pass
/// it, so they get today's real-export behaviour with no changes needed.
pub const LinkageMode = enum { dynamic, static };

/// The SDK's implementation, in solutions.
const SRC = "../../../solutions/capabilities/plugin/sdk/zig/src";

/// The extension-point registry — a CONTRACT, not part of this product. The
/// runtime needs it too, and a runtime cannot depend on an SDK.
const REGISTRY = "../../../solutions/contracts/plugin/registry/extension-points.zig";

/// The C ABI header. Part of the surface, so it lives in this product.
const INCLUDE = "../presentation/include";

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const linkage_mode = b.option(
        LinkageMode,
        "plugin-linkage",
        "Do extension-point implementations export real C symbols (dynamic, " ++
            "default) or stay module-scoped for an umbrella static build (static)?",
    ) orelse .dynamic;

    // Exposed to the SDK source as `@import("carbon_plugin_linkage").mode` —
    // see `sdk.ext.implement`/`implementManifest`, the only two places that
    // read it.
    const linkage_opts = b.addOptions();
    linkage_opts.addOption(LinkageMode, "mode", linkage_mode);
    const linkage_mod = linkage_opts.createModule();

    // The registry, as an importable module. Named `carbon_extension_points`
    // because that is what src/extension_points.zig imports.
    //
    // Not copied and not generated: a plugin importing it reads the same
    // declaration the runtime's Rust dispatch table and the toolchain's
    // TypeScript were rendered from, so there is no version of it that can be
    // stale on the plugin side.
    const registry_mod = b.addModule("carbon_extension_points", .{
        .root_source_file = b.path(REGISTRY),
        .target = target,
        .optimize = optimize,
    });

    // The SDK proper — what `@import("carbon_sdk")` resolves to.
    const carbon_sdk_mod = b.addModule("carbon_sdk", .{
        .root_source_file = b.path(SRC ++ "/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
    });
    carbon_sdk_mod.addImport("carbon_extension_points", registry_mod);
    carbon_sdk_mod.addImport("carbon_plugin_linkage", linkage_mod);
    carbon_sdk_mod.addIncludePath(b.path(INCLUDE));

    // Build a tiny library so `zig build` from here checks compilation.
    //
    // .addLibrary/.addTest take a pre-built *Module (.root_module) rather
    // than .root_source_file/.target/.optimize directly — the Build API this
    // was written against (0.13) offered both forms; the module-only form is
    // the one that survived. Include paths and libc linkage go through the
    // *Module directly, not the *Step.Compile forwarding methods (addIncludePath,
    // linkLibC) — those wrappers have appeared and disappeared across Zig
    // releases; the Module fields and methods underneath have not.
    const lib_mod = b.createModule(.{
        .root_source_file = b.path(SRC ++ "/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib_mod.addImport("carbon_extension_points", registry_mod);
    lib_mod.addImport("carbon_plugin_linkage", linkage_mod);
    lib_mod.addIncludePath(b.path(INCLUDE));

    const lib = b.addLibrary(.{
        .linkage = .static,
        .name = "carbon_sdk_check",
        .root_module = lib_mod,
    });
    b.installArtifact(lib);

    // `zig build test` — the SDK's own comptime assertions, plus the
    // registry's. The registry asserts its invariants in a `comptime` block,
    // so importing it at all is most of the check.
    const tests_mod = b.createModule(.{
        .root_source_file = b.path(SRC ++ "/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    tests_mod.addImport("carbon_extension_points", registry_mod);
    tests_mod.addImport("carbon_plugin_linkage", linkage_mod);
    tests_mod.addIncludePath(b.path(INCLUDE));

    const tests = b.addTest(.{ .root_module = tests_mod });

    const registry_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path(REGISTRY),
            .target = target,
            .optimize = optimize,
        }),
    });

    // manifest.zig's own tests never ran before this: `tests` above roots at
    // carbon_sdk.zig, and Zig's test runner only collects `test` blocks from
    // the root file itself, not ones in files it `@import`s — so
    // manifest.zig's tests (the multi-module export-grouping ones included)
    // were dead unless targeted directly, as this does.
    const manifest_tests_mod = b.createModule(.{
        .root_source_file = b.path(SRC ++ "/manifest.zig"),
        .target = target,
        .optimize = optimize,
    });
    manifest_tests_mod.addImport("carbon_extension_points", registry_mod);
    manifest_tests_mod.addImport("carbon_plugin_linkage", linkage_mod);
    const manifest_tests = b.addTest(.{ .root_module = manifest_tests_mod });

    const test_step = b.step("test", "Run the SDK and registry tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
    test_step.dependOn(&b.addRunArtifact(registry_tests).step);
    test_step.dependOn(&b.addRunArtifact(manifest_tests).step);
}
