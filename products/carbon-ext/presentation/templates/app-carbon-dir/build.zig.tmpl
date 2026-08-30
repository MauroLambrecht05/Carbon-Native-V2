// carbon/build.zig — the real entry point for this app's native plugin
// layer. `zig build` (run from here, with `--prefix .`) is the one command
// that fully populates carbon/bin/<os>/<arch>/ from manifest.toml — for
// every LOCAL plugin. A vendor (fetched/standard) plugin's binary+signature
// are written directly into carbon/bin/<os>/<arch>/ by SyncPluginsUseCase's
// auto-heal step (install/AddStandardPluginUseCase), never by this file —
// carbon/plugins/vendor/<name>/ holds only that plugin's carbon-plugin.toml,
// nothing this file needs to stage. This file skips vendor entries
// entirely; they exist in the manifest purely so the loader and the
// bundler know the name is real.
//
// Why local plugins are built via a SUBPROCESS rather than one in-process
// dependency graph: Zig's package manager requires every `b.dependency()`
// target pre-declared in build.zig.zon at compile time (resolved before
// `build()` ever runs) — a parent build.zig cannot turn a directory
// discovered here into a package dependency, and there is no API to compose
// a child build.zig's graph in-process. Each local plugin's OWN build.zig
// stays completely untouched (same as any plugin scaffolded outside an app);
// this file just orchestrates running it.
//
// carbon/build.zig.zon deliberately declares no dependencies — see its own
// header comment.

const std = @import("std");

const PluginSource = enum { local, vendor };

const ManifestEntry = struct {
    name: []const u8,
    source: PluginSource,
    enabled: bool,
};

/// Shallow, hand-rolled — same convention as every other tool-owned TOML
/// file in this codebase (no TOML library exists on the Zig side).
/// Understands exactly manifest.toml's shape: `[plugins.<name>]` headers,
/// `source`/`enabled` keys. See solutions/contracts/plugin/README.md and
/// AppManifestSection.ts (the TS-side reader/writer of the same file).
fn readManifest(b: *std.Build, io: std.Io) []const ManifestEntry {
    const text = b.build_root.handle.readFileAlloc(io, "manifest.toml", b.allocator, .limited(1024 * 1024)) catch return &.{};

    var entries = std.array_list.Managed(ManifestEntry).init(b.allocator);
    var name: ?[]const u8 = null;
    var source: ?PluginSource = null;
    var enabled: bool = true;

    const flush = struct {
        fn f(list: *std.array_list.Managed(ManifestEntry), n: ?[]const u8, s: ?PluginSource, e: bool) void {
            const nn = n orelse return;
            const ss = s orelse return;
            list.append(.{ .name = nn, .source = ss, .enabled = e }) catch @panic("OOM");
        }
    }.f;

    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;

        if (line[0] == '[' and line[line.len - 1] == ']') {
            flush(&entries, name, source, enabled);
            const header = line[1 .. line.len - 1];
            const prefix = "plugins.";
            if (std.mem.startsWith(u8, header, prefix)) {
                name = b.dupe(header[prefix.len..]);
                source = null;
                enabled = true;
            } else {
                name = null;
            }
            continue;
        }
        if (name == null) continue;

        const eq = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        const key = std.mem.trim(u8, line[0..eq], " \t");
        const value = std.mem.trim(u8, line[eq + 1 ..], " \t");

        if (std.mem.eql(u8, key, "source")) {
            const unquoted = std.mem.trim(u8, value, "\"");
            if (std.mem.eql(u8, unquoted, "local")) source = .local else if (std.mem.eql(u8, unquoted, "vendor")) source = .vendor;
        } else if (std.mem.eql(u8, key, "enabled")) {
            enabled = std.mem.eql(u8, value, "true");
        }
    }
    flush(&entries, name, source, enabled);
    return entries.items;
}

// Native target directory names — canonical table, quoted verbatim from
// solutions/contracts/plugin/README.md ("Native target directory names").
// plugin_loader.rs and the TS lifecycle use cases implement the same table
// and must agree with it exactly.
fn nativeOsName(tag: std.Target.Os.Tag) []const u8 {
    return switch (tag) {
        .windows => "windows",
        .linux => "linux",
        .macos => "macos",
        else => @panic("carbon: unsupported host OS for plugin staging"),
    };
}

fn nativeArchName(os: std.Target.Os.Tag, arch: std.Target.Cpu.Arch) []const u8 {
    return switch (arch) {
        .x86_64 => "x86_64",
        // Zig's own identifier is aarch64 on every OS; ours matches Apple's
        // convention on macOS specifically (see the README table).
        .aarch64 => if (os == .macos) "arm64" else "aarch64",
        else => @panic("carbon: unsupported host architecture for plugin staging"),
    };
}

fn nativeExt(tag: std.Target.Os.Tag) []const u8 {
    return switch (tag) {
        .windows => "dll",
        .linux => "so",
        .macos => "dylib",
        else => @panic("carbon: unsupported host OS for plugin staging"),
    };
}

/// A plugin's directory name (slug) is not a legal Zig identifier — the
/// built/staged artifact's crate-form filename is the same mechanical
/// transform CreatePluginUseCase.ts's PluginName.libraryFilename() always
/// applies: hyphens to underscores. No separate manifest field carries this;
/// deriving it here keeps manifest.toml from needing to know Zig's naming
/// rules.
fn crateName(b: *std.Build, slug: []const u8) []const u8 {
    const buf = b.allocator.dupe(u8, slug) catch @panic("OOM");
    for (buf) |*c| {
        if (c.* == '-') c.* = '_';
    }
    return buf;
}

pub fn build(b: *std.Build) void {
    const io = b.graph.io;
    const zig_exe = b.graph.zig_exe;
    const host = b.graph.host.result;
    const os_name = nativeOsName(host.os.tag);
    const arch_name = nativeArchName(host.os.tag, host.cpu.arch);
    const ext = nativeExt(host.os.tag);
    const bin_dir = b.fmt("bin/{s}/{s}", .{ os_name, arch_name });

    // `-Drelease` on THIS invocation forwards to every locally-built
    // plugin's own `zig build` — matches `carbon dev` (debug, fast rebuild)
    // vs. `carbon run`/`build` (release, what ships), the same distinction
    // a single plugin's own build.zig already makes for a standalone build.
    const release = b.option(bool, "release", "forward -Drelease=true to every carbon/plugins/local/* build") orelse false;

    for (readManifest(b, io)) |entry| {
        if (!entry.enabled or entry.source != .local) continue;

        const crate = crateName(b, entry.name);
        const artifact_name = b.fmt("{s}.{s}", .{ crate, ext });
        const staged_name = b.fmt("{s}.{s}", .{ entry.name, ext });
        const plugin_dir = b.pathJoin(&.{ "plugins", "local", entry.name });

        var argv = std.array_list.Managed([]const u8).init(b.allocator);
        argv.append(zig_exe) catch @panic("OOM");
        argv.append("build") catch @panic("OOM");
        if (release) argv.append("-Drelease=true") catch @panic("OOM");

        const built = b.addSystemCommand(argv.items);
        built.setCwd(.{ .cwd_relative = b.pathFromRoot(plugin_dir) });
        built.setName(b.fmt("zig build ({s})", .{entry.name}));

        // Windows puts the .dll in zig-out/bin (beside the .lib import
        // stub); every other OS puts the .so/.dylib in zig-out/lib — the
        // exact default std.Build.Step.InstallArtifact already applies, so
        // this just has to agree with it.
        const out_subdir = if (host.os.tag == .windows) "bin" else "lib";
        const artifact_path = b.pathJoin(&.{ plugin_dir, "zig-out", out_subdir, artifact_name });

        const staged = b.addInstallFileWithDir(b.path(artifact_path), .{ .custom = bin_dir }, staged_name);
        staged.step.dependOn(&built.step);
        b.getInstallStep().dependOn(&staged.step);
    }
}
