// build.zig — carbon-clipboard as a shared library the runtime dlopens.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const sdk = b.dependency("carbon-plugin-sdk", .{
        .target = target,
        .optimize = optimize,
    });

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    lib_mod.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    lib_mod.addIncludePath(sdk.path("../presentation/include"));

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "carbon_clipboard",
        .root_module = lib_mod,
    });
    b.installArtifact(lib);

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
