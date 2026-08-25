// build.zig — produces the shared library (.dll / .so / .dylib) that
// `carbon plugin install` copies into the app and the runtime dlopens.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // ReleaseSafe by default: a plugin runs inside the app's process, so a
    // bounds check that turns a corruption into a crash is worth the cycles.
    // `carbon plugin build --release` passes -Doptimize=ReleaseFast.
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const sdk = b.dependency("carbon-plugin-sdk", .{
        .target = target,
        .optimize = optimize,
    });

    // Include paths and libc linkage go through the *Module directly, not
    // the *Step.Compile forwarding methods (addIncludePath, linkLibC) —
    // those wrappers have appeared and disappeared across Zig releases; the
    // Module fields and methods underneath have not.
    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    lib_mod.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    // The C ABI header the SDK @cImports. It lives in the SDK product's
    // presentation/, beside the templates — both are surface.
    lib_mod.addIncludePath(sdk.path("../presentation/include"));

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        // carbon_idle, not carbon-idle: this is a hyphenated project name inside
        // build.zig, which SdkTemplateSource.ts's render() treats as a
        // non-source file (isSourceFile only matches src/) and so gives the
        // slug form to plain carbon-idle — but the shared-library FILENAME this
        // produces has to match PluginName.libraryFilename()'s crate-form
        // convention (a Rust/Zig-identifier-safe, underscored name), which
        // is exactly what carbon_idle always resolves to regardless of file.
        // Getting this wrong means `carbon plugin install` reports
        // "no built artifact found" for a build that actually succeeded.
        .name = "carbon_idle",
        .root_module = lib_mod,
    });
    b.installArtifact(lib);

    // `zig build test` runs the comptime assertions in src/main.zig — which
    // is where a wrong extension-point id or symbol name is caught.
    const tests_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    tests_mod.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    tests_mod.addIncludePath(sdk.path("../presentation/include"));

    const tests = b.addTest(.{ .root_module = tests_mod });

    const test_step = b.step("test", "Check the plugin against the extension-point registry");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
