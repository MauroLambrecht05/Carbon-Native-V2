// build.zig — carbon-clipboard as a shared library the runtime dlopens.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const sdk = b.dependency("carbon-plugin-sdk", .{
        .target = target,
        .optimize = optimize,
    });

    const lib = b.addSharedLibrary(.{
        .name = "carbon_clipboard",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib.root_module.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    lib.addIncludePath(sdk.path("../presentation/include"));
    lib.linkLibC();
    b.installArtifact(lib);

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
