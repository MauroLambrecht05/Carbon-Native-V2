// Builds the positive fixture.
//
// `.link_libc = true` deliberately: the real plugin template links libc
// (the SDK `@cImport`s the C ABI header), so a fixture that skipped it would
// be proving something easier than the real case. Combined with the MSVC ABI
// it costs three imports — memcpy, memmove, memset from vcruntime140 — and
// nothing else.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "allowed_plugin",
        .root_module = mod,
    });
    b.installArtifact(lib);
}
