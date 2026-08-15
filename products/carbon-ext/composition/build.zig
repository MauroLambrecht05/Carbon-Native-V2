// build.zig — the Carbon plugin SDK, as a Zig package.
//
// This is the composition root of the SDK: the one file that names every piece
// and wires them together. A plugin author's build.zig does
// `b.dependency("carbon-plugin-sdk", .{})` and then
// `sdk.module("carbon_sdk")`, and this is what answers.
//
// ── WHAT IT COMPOSES ────────────────────────────────────────────────────────
//   ../presentation/include/           the C ABI an author compiles against
//   ../../../solutions/capabilities/plugin-sdk/zig/src/
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

/// The SDK's implementation, in solutions.
const SRC = "../../../solutions/capabilities/plugin-sdk/zig/src";

/// The extension-point registry — a CONTRACT, not part of this product. The
/// runtime needs it too, and a runtime cannot depend on an SDK.
const REGISTRY = "../../../solutions/contracts/plugin/registry/extension-points.zig";

/// The C ABI header. Part of the surface, so it lives in this product.
const INCLUDE = "../presentation/include";

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

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
    carbon_sdk_mod.addIncludePath(b.path(INCLUDE));

    // Build a tiny library so `zig build` from here checks compilation.
    const lib = b.addStaticLibrary(.{
        .name = "carbon_sdk_check",
        .root_source_file = b.path(SRC ++ "/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib.root_module.addImport("carbon_extension_points", registry_mod);
    lib.addIncludePath(b.path(INCLUDE));
    b.installArtifact(lib);

    // `zig build test` — the SDK's own comptime assertions, plus the
    // registry's. The registry asserts its invariants in a `comptime` block,
    // so importing it at all is most of the check.
    const tests = b.addTest(.{
        .root_source_file = b.path(SRC ++ "/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
    });
    tests.root_module.addImport("carbon_extension_points", registry_mod);
    tests.addIncludePath(b.path(INCLUDE));
    tests.linkLibC();

    const registry_tests = b.addTest(.{
        .root_source_file = b.path(REGISTRY),
        .target = target,
        .optimize = optimize,
    });

    const test_step = b.step("test", "Run the SDK and registry tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
    test_step.dependOn(&b.addRunArtifact(registry_tests).step);
}
