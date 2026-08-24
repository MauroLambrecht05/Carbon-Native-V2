// carbon_crt — a real CRT monitor simulation, computed on the actual
// framebuffer every frame.
//
//   zig build                 build it
//   carbon plugin install     copy it into the app and declare it
//   carbon plugin check       verify this file against the registry
//
// ── HOW A PLUGIN WORKS ──────────────────────────────────────────────────────
// A plugin is a shared library that exports C symbols. The runtime looks each
// one up by name after loading the library; a symbol it finds is an extension
// point the plugin implements, and one it does not find is a point the plugin
// simply does not take part in. Nothing is registered at runtime and there is
// no callback table to fill in — the export IS the registration.
//
// Which symbols exist, what each one is called and when the runtime calls it
// is the registry:
//
//   solutions/contracts/plugin/registry/extension-points.zig
//
// You can read it directly, or ask:
//
//   carbon ext list           every point, one line each
//   carbon ext show <id>      one point, with the Zig to implement it
//
// ── WHY THIS NEEDS A PLUGIN, NOT CSS ─────────────────────────────────────────
// A browser page never sees its own rendered pixels — the closest web
// equivalent is a WebGL post-process pass, which means the app's entire UI
// has to be a <canvas> your own shader reads back, not an effect dropped
// onto an app that already exists. `paint.before` hands this plugin the
// exact RGBA8 bytes Carbon is about to present, after rasterizing and
// before the OS draws them, and this plugin darkens alternating rows
// (scanlines) and applies a corner falloff (vignette) directly on those
// bytes. Any Carbon app gets this by installing the plugin and granting one
// capability — zero changes to the app's own JS/TSX.

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── The manifest ────────────────────────────────────────────────────────────
//
// Returned to the runtime BEFORE any of this plugin's code runs, so the
// loader can check the ABI and the capability grants first. Built at comptime,
// so `.points` is checked against the registry when you compile: a misspelled
// id fails the build rather than producing a plugin that loads and does
// nothing.
//
// The capability list is derived — paint.before contributes paint.pixmap
// automatically, so `required` here is only for things that are not
// extension points, and this plugin has none. `.modules` is empty for the
// same reason: there is no `carbon:carbon_crt` import for JS code to reach
// for, because the effect is unconditional the moment the plugin loads.
const MANIFEST = sdk.manifest.build(.{
    .name = "carbon_crt",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "paint.before" },
});

export fn carbon_plugin_manifest() callconv(.C) [*:0]const u8 {
    return MANIFEST;
}

// ── lifecycle.register ──────────────────────────────────────────────────────
//
// Nothing to install — the effect needs no JS-side state. Registered anyway
// so the plugin says something on load; a plugin that is silent end to end
// looks identical to one that failed to load.
comptime {
    const point = sdk.ext.expect("lifecycle.register");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_register"));
}

export fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.C) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);

    // A major ABI mismatch means the struct layout differs; every field read
    // after this point would be garbage. The loader checks it too, from the
    // manifest — this is the belt to that pair of braces.
    if (!app.abiCompatible()) return;

    std.debug.print("[carbon-crt] phosphor simulation active\n", .{});
}

// ── paint.before ─────────────────────────────────────────────────────────────
//
// Capability-gated: a plugin that can write the framebuffer can draw
// anything anywhere, including over UI the user is about to click (see the
// registry's own doc for paint.before). The host app has to grant
// paint.pixmap explicitly in its carbon.toml — declaring the point here is
// a request, not a grant.
comptime {
    const point = sdk.ext.expect("paint.before");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_before_paint"));
}

// Every other row, darkened — the gap between a CRT's phosphor lines.
// Multiplicative, so it reads clearly on bright content (glowing text) the
// way a real phosphor screen does, and stays understated on the already-dark
// background between elements — also true to how a real CRT looks: the
// scanline structure is only visible where something is lit.
const SCANLINE_PERIOD: u32 = 2;
const SCANLINE_DARKEN: f32 = 0.6;

// Corner darkening: 0 at the exact center (no darkening), reaching
// VIGNETTE_STRENGTH at the frame's own corner distance. A curved tube face
// is brightest in the middle and falls off toward the bezel — this is that
// falloff, not a hard-edged circle.
const VIGNETTE_STRENGTH: f32 = 0.45;

export fn carbon_plugin_before_paint(
    app_raw: *sdk.RawApp,
    pixmap: [*]u8,
    width: u32,
    height: u32,
    stride_bytes: u32,
) callconv(.C) void {
    _ = app_raw;
    applyCrt(pixmap[0 .. @as(usize, stride_bytes) * height], width, height, stride_bytes);
}

fn applyCrt(pixmap: []u8, width: u32, height: u32, stride_bytes: u32) void {
    if (width == 0 or height == 0) return;

    const half_w: f32 = @as(f32, @floatFromInt(width)) * 0.5;
    const half_h: f32 = @as(f32, @floatFromInt(height)) * 0.5;
    // Squared, and never square-rooted: the falloff only ever needs
    // distance², so skipping sqrt entirely is free accuracy, not an
    // approximation.
    const max_dist_sq = half_w * half_w + half_h * half_h;

    var y: u32 = 0;
    while (y < height) : (y += 1) {
        const row_start = @as(usize, y) * @as(usize, stride_bytes);
        const row = pixmap[row_start..][0 .. @as(usize, width) * 4];

        const dy = @as(f32, @floatFromInt(y)) + 0.5 - half_h;
        const scanline: f32 = if (y % SCANLINE_PERIOD == 0) SCANLINE_DARKEN else 1.0;

        var x: u32 = 0;
        while (x < width) : (x += 1) {
            const dx = @as(f32, @floatFromInt(x)) + 0.5 - half_w;
            const dist_sq = (dx * dx + dy * dy) / max_dist_sq;
            const vignette = 1.0 - clamp01(dist_sq) * VIGNETTE_STRENGTH;
            const mult = scanline * vignette;

            const i = @as(usize, x) * 4;
            row[i] = scaleChannel(row[i], mult);
            row[i + 1] = scaleChannel(row[i + 1], mult);
            row[i + 2] = scaleChannel(row[i + 2], mult);
            // row[i + 3] (alpha) untouched. RGB is premultiplied, so scaling
            // all three channels by the same factor and leaving alpha alone
            // is exactly "darken this pixel's visible color" — premultiplied
            // color is (actual_color * alpha), and (actual_color * mult) *
            // alpha == (actual_color * alpha) * mult either way the
            // multiplication associates.
        }
    }
}

fn scaleChannel(v: u8, mult: f32) u8 {
    const scaled = @as(f32, @floatFromInt(v)) * mult;
    return @intFromFloat(clamp01(scaled / 255.0) * 255.0);
}

fn clamp01(v: f32) f32 {
    return @min(1.0, @max(0.0, v));
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// No window, no device — applyCrt operates on a plain byte slice, so this is
// testable the same way carbon-layout's scene.rs tests are: pure logic over
// plain data. `zig build test` runs these plus the comptime assertions
// above, which is where a wrong extension-point id or symbol name is caught.

test "the manifest declares both points and no JS module" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon_crt\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "paint.before") != null);
}

test "the manifest is valid JSON" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        arena.allocator(),
        std.mem.span(MANIFEST),
        .{},
    );
    try std.testing.expect(parsed.value == .object);
}

test "the center pixel of an odd row is untouched" {
    // y=1 is not a multiple of SCANLINE_PERIOD (2), and the center pixel's
    // distance from center is 0, so vignette is 1.0 too — mult should be
    // exactly 1.0, meaning every channel survives unchanged.
    const width: u32 = 3;
    const height: u32 = 3;
    const stride = width * 4;
    var buf = [_]u8{ 100, 150, 200, 255 } ** (width * height);

    applyCrt(&buf, width, height, stride);

    const center = 1 * stride + 1 * 4;
    try std.testing.expectEqual(@as(u8, 100), buf[center]);
    try std.testing.expectEqual(@as(u8, 150), buf[center + 1]);
    try std.testing.expectEqual(@as(u8, 200), buf[center + 2]);
    try std.testing.expectEqual(@as(u8, 255), buf[center + 3]);
}

test "a scanline row is darkened, and alpha is never touched" {
    const width: u32 = 2;
    const height: u32 = 1;
    const stride = width * 4;
    // y=0 is a scanline row (0 % 2 == 0).
    var buf = [_]u8{ 200, 200, 200, 255, 200, 200, 200, 128 };

    applyCrt(&buf, width, height, stride);

    try std.testing.expect(buf[0] < 200);
    try std.testing.expect(buf[1] < 200);
    try std.testing.expect(buf[2] < 200);
    try std.testing.expectEqual(@as(u8, 255), buf[3]);
    try std.testing.expectEqual(@as(u8, 128), buf[7]);
}

test "corners darken more than the center" {
    const width: u32 = 100;
    const height: u32 = 100;
    const stride = width * 4;
    var buf = [_]u8{255} ** (width * height * 4);

    applyCrt(&buf, width, height, stride);

    // Row 49 is not a scanline row (49 % 2 != 0), isolating the vignette.
    const center_i = 49 * stride + 50 * 4;
    const corner_i = 49 * stride + 0 * 4;
    try std.testing.expect(buf[corner_i] < buf[center_i]);
}

test "a zero-sized pixmap does not divide by zero or crash" {
    var buf = [_]u8{};
    applyCrt(&buf, 0, 0, 0);
}

test "scaleChannel clamps rather than wraps" {
    try std.testing.expectEqual(@as(u8, 0), scaleChannel(10, 0.0));
    try std.testing.expectEqual(@as(u8, 255), scaleChannel(255, 2.0));
}
