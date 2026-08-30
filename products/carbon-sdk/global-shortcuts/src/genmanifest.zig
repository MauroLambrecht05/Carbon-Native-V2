// Prints this plugin's carbon-plugin.toml, generated from main.zig's own
// `CFG` — `zig build gen-manifest` captures this and writes it back to
// carbon-plugin.toml. See manifest.zig's `toToml` doc comment for why
// that file exists at all alongside `CFG`, given the runtime never reads
// it.
const std = @import("std");
const sdk = @import("carbon_sdk");
const app = @import("main.zig");

pub fn main() void {
    // std.debug.print (stderr), not a stdout writer — Zig 0.16's stdout
    // path needs an explicit `Io` context to thread through; this is a
    // one-shot codegen helper, not worth the ceremony. build.zig captures
    // stderr accordingly (see captureStdErr there).
    const toml = comptime sdk.manifest.toToml(app.CFG);
    std.debug.print("{s}", .{toml});
}
