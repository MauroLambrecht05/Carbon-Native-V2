// Builds the negative fixture. Nothing here is plugin-template shaped on
// purpose: no SDK dependency, no libc, no std — see src/main.zig for why the
// fixture has to be that bare to prove anything.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "denied_plugin",
        .root_module = mod,
    });
    b.installArtifact(lib);
}
