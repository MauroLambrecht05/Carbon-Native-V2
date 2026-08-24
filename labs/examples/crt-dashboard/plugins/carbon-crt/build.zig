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

    const lib = b.addSharedLibrary(.{
        .name = "carbon_crt",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib.root_module.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    // The C ABI header the SDK @cImports. It lives in the SDK product's
    // presentation/, beside the templates — both are surface.
    lib.addIncludePath(sdk.path("../presentation/include"));
    lib.linkLibC();

    b.installArtifact(lib);

    // `zig build test` runs the comptime assertions in src/main.zig — which
    // is where a wrong extension-point id or symbol name is caught.
    const tests = b.addTest(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    tests.root_module.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    tests.addIncludePath(sdk.path("../presentation/include"));
    tests.linkLibC();

    const test_step = b.step("test", "Check the plugin against the extension-point registry");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
