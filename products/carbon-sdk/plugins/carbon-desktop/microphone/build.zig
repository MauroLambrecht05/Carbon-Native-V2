// build.zig — produces the shared library (.dll / .so / .dylib) that
// `carbon plugin install` / `carbon plugin add microphone` copies into the
// app and the runtime dlopens.

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
        // Must match PluginName.from("microphone").crate exactly — this is
        // the shared-library filename InstallPluginUseCase's
        // locateArtifact() searches for by that derived name. The plugin's
        // own carbon-plugin.toml `name` field ("microphone") is what that
        // name comes from.
        .name = "microphone",
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

    // `zig build gen-manifest` regenerates carbon-plugin.toml from
    // src/main.zig's own CFG — see genmanifest.zig and manifest.zig's
    // `toToml` doc comment for why that file exists at all once main.zig
    // already declares the same config.
    const genmanifest_mod = b.createModule(.{
        .root_source_file = b.path("src/genmanifest.zig"),
        .target = target,
        .optimize = optimize,
    });
    genmanifest_mod.addImport("carbon_sdk", sdk.module("carbon_sdk"));
    const genmanifest_exe = b.addExecutable(.{ .name = "genmanifest", .root_module = genmanifest_mod });
    const run_genmanifest = b.addRunArtifact(genmanifest_exe);
    const toml_output = run_genmanifest.captureStdErr(.{});
    const update = b.addUpdateSourceFiles();
    update.addCopyFileToSource(toml_output, "carbon-plugin.toml");
    const gen_step = b.step("gen-manifest", "Regenerate carbon-plugin.toml from src/main.zig's manifest config");
    gen_step.dependOn(&update.step);
}
