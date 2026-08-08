// build.zig — Zig package definition for the Carbon plugin SDK.
//
// Plugin authors using Zig add this package to their build.zig.zon and
// then `b.dependency("carbon-plugin-sdk", .{})` from their own build.zig.
// See templates/plugin/build.zig.tmpl for the consumer side.
//
// This build.zig itself only defines the module surface (carbon_sdk.zig)
// and exposes the C header path so consumers can `@cInclude("carbon_plugin.h")`.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Expose the Zig wrapper as a public module.
    const carbon_sdk_mod = b.addModule("carbon_sdk", .{
        .root_source_file = b.path("src/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Make the C header path discoverable for consumers that want to
    // @cImport it directly.
    carbon_sdk_mod.addIncludePath(b.path("../include"));

    // Build a tiny library so `zig build` from here checks compilation.
    const lib = b.addStaticLibrary(.{
        .name = "carbon_sdk_check",
        .root_source_file = b.path("src/carbon_sdk.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib.addIncludePath(b.path("../include"));
    b.installArtifact(lib);
}
